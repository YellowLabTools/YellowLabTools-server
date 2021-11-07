var debug       = require('debug')('ylt:24HoursRecordTable');


// Saves visits history and tells when limits are overpassed
function RecordTable(maxPerDay) {
    var table = {};

    // Check if the user overpassed the limit and save its visit
    this.accepts = function(key) {
        if (table[key]) {
            
            this.cleanEntry(key);

            debug('%d hits in the last 24 hours', table[key].length);

            if (table[key].length >= maxPerDay) {
                return false;
            } else {
                table[key].push(Date.now());
            }

        } else {
            table[key] = [];
            table[key].push(Date.now());
        }

        return true;
    };

    // Clean the table for this guy
    this.cleanEntry = function(key) {
        table[key] = table[key].filter(function(date) {
            return date > Date.now() - 1000*60*60*24;
        });
    };

    // Clean the entire table once in a while
    this.removeOld = function() {
        for (var key in table) {
            this.cleanEntry(key);
        }
    };

}

module.exports = RecordTable;