var fs          = require('fs');
var rimraf      = require('rimraf');
var path        = require('path');
var Q           = require('q');
var debug       = require('debug')('ylt:resultsDatastore');


function ResultsDatastore() {
    'use strict';

    var resultFileName = 'results.json';
    var resultScreenshotName = 'screenshot.jpg';
    var resultsFolderName = 'results';
    var resultsDir = path.join(__dirname, '..', '..', resultsFolderName);


    this.saveResult = function(testResults) {
        return createResultFolder(testResults.runId)

            .then(function() {

                debug('Saving results to disk...');

                var resultFilePath = path.join(resultsDir, testResults.runId, resultFileName);
                debug('Destination file is %s', resultFilePath);
                
                return Q.nfcall(fs.writeFile, resultFilePath, JSON.stringify(testResults, null, 2));
            });
    };


    this.getResult = function(runId) {

        var resultFilePath = path.join(resultsDir, runId, resultFileName);

        debug('Reading results (runID = %s) from disk...', runId);
        
        return Q.nfcall(fs.readFile, resultFilePath, {encoding: 'utf8'}).then(function(data) {
            return JSON.parse(data);
        });
    };


    this.deleteResult = function(runId) {
        var folder = path.join(resultsDir, runId);

        debug('Deleting results (runID = %s) from disk...', runId);

        return Q.nfcall(rimraf, folder);
    };


    // The folder /results/folderName/
    function createResultFolder(runId) {
        var deferred = Q.defer();
        var folder = path.join(resultsDir, runId);

        fs.exists(folder, function(exists) {
            if (exists) {
                deferred.resolve();
            } else {
                debug('Creating the folder %s', runId);
                fs.mkdir(folder, function(err) {
                    if (err) {
                        deferred.reject(err);
                    } else {
                        deferred.resolve();
                    }
                });
            }
        });

        return deferred.promise;
    }
    

    // The folder /results/
    function createGlobalFolder() {
        var deferred = Q.defer();

        // Create the results folder if it doesn't exist
        fs.exists(resultsDir, function(exists) {
            if (exists) {
                deferred.resolve();
            } else {
                debug('Creating the global results folder', resultsDir);
                fs.mkdir(resultsDir, function(err) {
                    if (err) {
                        deferred.reject(err);
                    } else {
                        deferred.resolve();
                    }
                });
            }
        });

        return deferred.promise;
    }

    this.getResultFolder = function(runId) {
        return path.join(resultsDir, runId);
    };


    // Save a bufferized screenshot on the disk
    this.saveScreenshot = function(runId, screenshotBuffer) {
        return createResultFolder(runId)

            .then(function() {

                debug('Saving screenshot to disk...');

                var screenshotFilePath = path.join(resultsDir, runId, resultScreenshotName);
                debug('Destination file is %s', screenshotFilePath);
                
                return Q.nfcall(fs.writeFile, screenshotFilePath, screenshotBuffer)

                    .fail(function(err) {
                        debug('Failed to save the screenshot with error %s', err);
                    });
            });
    }


    this.getScreenshot = function(runId) {

        var screenshotFilePath = path.join(resultsDir, runId, resultScreenshotName);

        debug('Getting screenshot (runID = %s) from disk...', runId);
        
        return Q.nfcall(fs.readFile, screenshotFilePath);
    };
}

module.exports = ResultsDatastore;