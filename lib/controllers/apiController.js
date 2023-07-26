var debug               = require('debug')('ylt:server');
var Q                   = require('q');
var path                = require('path');

var yltAgent            = require('yellowlabtools');
var RunsQueue           = require('../datastores/runsQueue');
var RunsDatastore       = require('../datastores/runsDatastore');
var ResultsDatastore    = require('../datastores/resultsDatastore');

var serverSettings      = (process.env.IS_TEST) ? require('../../test/fixtures/settings.json') : require('../../server_config/settings.json');
var isAWS               = !!serverSettings.awsHosting;


// The official YLT instance is hosted on AWS
// Private instances are hosted locally
// Depending on the configuration, we load various modules:
var AWS, ResultsDatastore;

if (isAWS) {
    
    AWS = require('aws-sdk');
    ResultsDatastore = require('../datastores/awsResultsDatastore');

    // Increase AWS Lambda timeout  
    AWS.config.update({httpOptions: {timeout: 240000}});

} else {
    
    ResultsDatastore = require('../datastores/resultsDatastore');
}


var ApiController = function(app) {
    'use strict';

    var queue = new RunsQueue();
    var runsDatastore = new RunsDatastore();
    var resultsDatastore = new ResultsDatastore();

    // Create a new run
    app.post('/api/runs', function(req, res) {

        // Add https to the test URL
        if (req.body.url && req.body.url.toLowerCase().indexOf('http://') !== 0 && req.body.url.toLowerCase().indexOf('https://') !== 0) {
            req.body.url = 'https://' + req.body.url;
        }

        // Block requests to unwanted websites (=spam)
        if (req.body.url && isBlocked(req.body.url)) {
            console.error('Test blocked for URL: %s', req.body.url);
            res.status(403).send('Forbidden');
            return;
        }

        // Grab the test parameters and generate a random run ID
        var run = {
            runId: (Date.now()*1000 + Math.round(Math.random()*1000)).toString(36),
            params: {
                url: req.body.url,
                partialResult: req.body.partialResult || null,
                screenshot: req.body.screenshot || false,
                device: req.body.device || 'desktop',
                proxy: req.body.proxy || null,
                waitForSelector: req.body.waitForSelector || null,
                cookie: req.body.cookie || null,
                authUser: req.body.authUser || null,
                authPass: req.body.authPass || null,
                blockDomain: req.body.blockDomain || null,
                allowDomain: req.body.allowDomain || null,
                noExternals: req.body.noExternals || false
            }
        };

        // Add test to the testQueue
        debug('Adding test %s to the queue', run.runId);
        var queuePromise = queue.push(run.runId);

        // Save the run to the datastore
        if (isAWS) {

            // There is no queue on an AWS instance, we assume the number of agents is sufficient
            runsDatastore.add(run, 0);

        } else {
            
            runsDatastore.add(run, queuePromise.startingPosition);

            // Listen for position updates
            queuePromise.progress(function(position) {
                runsDatastore.updatePosition(run.runId, position);
            });
        }

        // Let's start the run
        queuePromise.then(function() {

            runsDatastore.updatePosition(run.runId, 0);

            console.log('Launching test ' + run.runId + ' on ' + run.params.url);

            var runOptions = {
                screenshot: run.params.screenshot ? path.join(__dirname, '../../tmp/temp-screenshot.png') : false,
                device: run.params.device,
                proxy: run.params.proxy,
                waitForSelector: run.params.waitForSelector,
                cookie: run.params.cookie,
                authUser: run.params.authUser,
                authPass: run.params.authPass,
                blockDomain: run.params.blockDomain,
                allowDomain: run.params.allowDomain,
                noExternals: run.params.noExternals
            };


            if (isAWS) {

                const {region, arn} = chooseLambdaRegionByGeoIP(req.headers);
                const lambda = new AWS.Lambda({region: region});

                // Let's call the distant agent through AWS
                return lambda.invoke({   
                    FunctionName: arn,  
                    InvocationType: 'RequestResponse',  
                    Payload: JSON.stringify({url: run.params.url, id: run.runId, options: runOptions})  
                })

                .promise()

                .then(function(response) {

                    debug('We\'ve got a response from AWS Lambda'); 
                    debug('StatusCode = %d', response.StatusCode);  
                    debug('Payload = %s', response.Payload);

                    if (response.StatusCode === 200 && response.Payload && response.Payload !== 'null') {   
                        const payload = JSON.parse(response.Payload);   
                        if (payload.status === 'failed') {  
                            debug('Failed with error %s', payload.errorMessage);    
                            runsDatastore.markAsFailed(run.runId, payload.errorMessage);    
                        } else {    
                            debug('Success!');  
                            runsDatastore.markAsComplete(run.runId);    
                        }   
                    } else {    
                        debug('Empty response from the lambda agent');  
                        runsDatastore.markAsFailed(run.runId, "Empty response from the agent");
                    }
                })

                .catch(function(err) {  
                    debug('Error from AWS Lambda:');    
                    debug(err);
                    runsDatastore.markAsFailed(run.runId, err.toString());  
                });


            } else {

                // Specify the function that will be called to save the screenshot
                // path: a string that represents the file name ('screenshot.jpg')
                // content: a buffered jpeg image file
                if (run.params.screenshot) {
                    runOptions.saveScreenshotFn = async (fileName, screenshotBuffer) => {
                        return resultsDatastore.saveScreenshot(run.runId, screenshotBuffer);
                   };
                }

                // Let's call the local agent
                return yltAgent(run.params.url, runOptions)

                // Update the progress bar on each progress
                .progress(function(progress) {
                    runsDatastore.updateRunProgress(run.runId, progress);
                })

                .then(function(data) {

                    debug('Success');
                    data.runId = run.runId;

                    // Remove uneeded temp screenshot paths
                    delete data.params.options.screenshot;

                    // Here we can remove tools results if not needed
                    delete data.toolsResults.phantomas.offenders.requests;

                    runsDatastore.markAsComplete(run.runId);

                    debug('Saving results in datastore');
                    return resultsDatastore.saveResult(data);
                })

                .fail(function(err) {
                    console.error('Test failed for URL: %s', run.params.url);
                    console.error(err.toString());

                    runsDatastore.markAsFailed(run.runId, err.toString());
                });
            }
        })

        .finally(function() {
            queue.remove(run.runId);
        });


        // Sending the run ID without waiting for the end of the run
        debug('Sending response without waiting.');
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify({runId: run.runId}));

    });

    // Reads the Geoip_Continent_Code header and chooses the right region from the settings 
    function chooseLambdaRegionByGeoIP(headers) {

        // The settings can be configured like this in server_config/settings.json: 
        //  
        // "awsHosting": {  
        //     "lambda": {  
        //         "regionByContinent": {   
        //             "AF": "eu-west-3",   
        //             "AS": "ap-southeast-1",  
        //             "EU": "eu-west-3",   
        //             "NA": "us-east-1",   
        //             "OC": "ap-southeast-1",  
        //             "SA": "us-east-1",   
        //             "default": "eu-west-3"   
        //         },   
        //         "arnByRegion": { 
        //             "us-east-1": "arn:aws:lambda:us-east-1:xxx:function:xxx",    
        //             "eu-west-3": "arn:aws:lambda:eu-west-3:xxx:function:xxx",    
        //             "ap-southeast-1": "arn:aws:lambda:ap-southeast-1:xxx:function:xxx"   
        //         }    
        //     }    
        // },

        const header = headers.geoip_continent_code;    
        debug('Value of the Geoip_Continent_Code header: %s', header);

        const continent = header || 'default';  
        const region = serverSettings.awsHosting.lambda.regionByContinent[continent];   
        const arn = serverSettings.awsHosting.lambda.arnByRegion[region];   
        debug('The chosen AWS Lambda is: %s', arn);

        return {region, arn};   
    }


    // Retrive one run by id
    app.get('/api/runs/:id', function(req, res) {
        var runId = req.params.id;

        var run = runsDatastore.get(runId);

        if (run) {
            res.setHeader('Content-Type', 'application/json');
            res.send(JSON.stringify(run, null, 2));
        } else {
            res.status(404).send('Not found');
        }
    });

    // Counts all pending runs
    app.get('/api/runs', function(req, res) {
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify({
            pendingRuns: queue.length(),
            timeSinceLastTestStarted: queue.timeSinceLastTestStarted()
        }, null, 2));
    });

    // Delete one run by id
    /*app.delete('/api/runs/:id', function(req, res) {
        deleteRun()
    });*/

    // Delete all
    /*app.delete('/api/runs', function(req, res) {
        purgeRuns()
    });

    // List all
    app.get('/api/runs', function(req, res) {
        listRuns()
    });

    // Exists
    app.head('/api/runs/:id', function(req, res) {
        existsX();
        // Returns 200 if the result exists or 404 if not
    });
    */

    // Retrive one result by id
    app.get('/api/results/:id', function(req, res) {
        getPartialResults(req.params.id, res, function(data) {
            
            // Some fields can be excluded from the response, this way:
            // /api/results/:id?exclude=field1,field2
            if (req.query.exclude && typeof req.query.exclude === 'string') {
                var excludedFields = req.query.exclude.split(',');
                excludedFields.forEach(function(fieldName) {
                    if (data[fieldName]) {
                        delete data[fieldName];
                    }
                });
            }

            return data;
        });
    });

    // Retrieve one result and return only the generalScores part of the response
    app.get('/api/results/:id/generalScores', function(req, res) {
        getPartialResults(req.params.id, res, function(data) {
            return data.scoreProfiles.generic;
        });
    });

    app.get('/api/results/:id/generalScores/:scoreProfile', function(req, res) {
        getPartialResults(req.params.id, res, function(data) {
            return data.scoreProfiles[req.params.scoreProfile];
        });
    });

    app.get('/api/results/:id/rules', function(req, res) {
        getPartialResults(req.params.id, res, function(data) {
            return data.rules;
        });
    });

    app.get('/api/results/:id/javascriptExecutionTree', function(req, res) {
        getPartialResults(req.params.id, res, function(data) {
            return data.javascriptExecutionTree;
        });
    });

    app.get('/api/results/:id/toolsResults/phantomas', function(req, res) {
        getPartialResults(req.params.id, res, function(data) {
            return data.toolsResults.phantomas;
        });
    });

    function getPartialResults(runId, res, partialGetterFn) {
        resultsDatastore.getResult(runId)
            .then(function(data) {
                var results = partialGetterFn(data);

                results.screenshotUrl = '/api/results/' + results.runId + '/screenshot.jpg';
                
                if (typeof results === 'undefined') {
                    res.status(404).send('Not found');
                    return;
                }

                res.setHeader('Content-Type', 'application/json');
                res.send(JSON.stringify(results, null, 2));

            }).fail(function() {
                res.status(404).send('Not found');
            });
    }

    // Retrive one result by id
    app.get('/api/results/:id/screenshot.jpg', function(req, res) {
        var runId = req.params.id;

        resultsDatastore.getScreenshot(runId)
            .then(function(screenshotBuffer) {
                
                res.setHeader('Content-Type', 'image/jpeg');
                res.send(screenshotBuffer);

            }).fail(function() {
                res.status(404).send('Not found');
            });
    });

    function isBlocked(url) {
        if (!serverSettings.blockedUrls) {
            return false;
        }

        return serverSettings.blockedUrls.some(function(blockedUrl) {
            return (url.indexOf(blockedUrl) >= 0);
        });
    }
};

module.exports = ApiController;
