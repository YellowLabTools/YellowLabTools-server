var config = (process.env.IS_TEST) ? require('../../test/fixtures/settings.json') : require('../../server_config/settings.json');

var RecordTable = require('../datastores/24HoursRecordTable');

var debug = require('debug')('ylt:apiLimitsMiddleware');


var apiLimitsMiddleware = function(req, res, next) {
    'use strict';

    var ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    debug('Entering API Limits Middleware with IP address %s', ipAddress);

    if (req.path.indexOf('/api/') === 0 && !res.locals.hasApiKey) {
        
        
        // Monitoring requests
        if (req.path === '/api/runs' && req.method === 'GET') {
            next();
            return;
        }

        // New tests 
        if (req.path === '/api/runs' && req.method === 'POST') {
            
            if (!runsTable.accepts(ipAddress)) {
                // Sorry :/
                debug('Too many tests launched from IP address %s', ipAddress);
                res.status(429).send('Too many requests');
                return;
            }

        }

        // Every other calls
        if (!callsTable.accepts(ipAddress)) {
            // Sorry :/
            debug('Too many API requests from IP address %s', ipAddress);
            res.status(429).send('Too many requests');
            return;
        }

        debug('Not blocked by the API limits');
        // It's ok for the moment
    }

    next();
};

// Init the records tables
var runsTable = new RecordTable(config.maxAnonymousRunsPerDay);
var callsTable = new RecordTable(config.maxAnonymousCallsPerDay);

module.exports = apiLimitsMiddleware;