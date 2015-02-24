// Copyright 2014-2015, Renasar Technologies Inc.
/* jshint node: true */

'use strict';

var di = require('di'),
    fs = require('fs'),
    path = require('path');

module.exports = ChildProcessFactory;

di.annotate(ChildProcessFactory, new di.Provide('ChildProcess'));
di.annotate(ChildProcessFactory,
    new di.Inject(
        'child_process',
        'Errors',
        'Logger',
        'Assert',
        'Util',
        'Q',
        '_'
    )
);

/**
 * childProcessFactory returns a ChildProcess constructor
 * @param {Q} Q Promise Library
 * @param {Logger} Logger module
 * @param {Object} assert assertion module
 * @param {Object} _ lodash module
 * @private
 */
function ChildProcessFactory (nodeChildProcess, Errors, Logger, assert, util, Q, _) {
    var logger = Logger.initialize(ChildProcessFactory);

    function JobKilledError(message) {
        JobKilledError.super_.call(this, message);
        Error.captureStackTrace(this, JobKilledError);
    }
    util.inherits(JobKilledError, Errors.BaseError);

    /**
     * ChildProcess provides a promise based mechanism to run shell commands
     * in a fairly secure manner.
     * @constructor
     */
    function ChildProcess (command, args, env, code) {
        var self = this;


        self.command = command;
        self.file = self._parseCommandPath(self.command);
        self.args = args;
        self.environment = env || {};
        self.exitCode = code || 0;

        if (!self.file) {
            throw new Error('Unable to locate command file (' + self.command +').');
        }
        if (!_.isEmpty(self.args)) {
            try {
                assert.arrayOfString(self.args, 'ChildProcess command arguments');
            } catch (e) {
                throw new Error('args must be an array of strings');
            }
        }

        self.hasBeenKilled = false;
        self.spawnInstance = undefined;
        self.done = false;

        self._deferred = Q.defer();
    }

    ChildProcess.prototype.resolve = function() {
        if (this.done) {
            logger.warning("ChildProcess promise has already been resolved");
            return;
        }
        this.done = true;
        this._deferred.resolve();
    };

    ChildProcess.prototype.reject = function(error) {
        if (this.done) {
            logger.warning("ChildProcess promise has already been rejected");
            return;
        }
        this.done = true;
        this._deferred.reject(error);
    };

    ChildProcess.prototype.killSafe = function (signal) {
        if (!this.hasBeenKilled && this.spawnInstance && _.isFunction(this.spawnInstance.kill)) {
            this.spawnInstance.kill(signal);
        } else {
            this.hasBeenKilled = true;
        }
    };

    /**
     * Runs the given command.
     * @param  {String} command File to run, with path or without.
     * @param  {String[]} args    Arguments to the file.
     * @param  {Object} env     Optional environment variables to provide.
     * @param  {Integer} code   Desired exit code, defaults to 0.
     * @return {Q.Promise}        A promise fulfilled with the stdout, stderr of
     * a successful command.
     */
    ChildProcess.prototype._run = function () {
        var self = this;

        if (self.hasBeenKilled) {
            self.reject(new JobKilledError("ChildProcess job has been killed", {
                command: self.command,
                argv: self.args
            }));
            return;
        }

        self.spawnInstance = nodeChildProcess.execFile(
                self.file, self.args, self.environment, function (error, stdout, stderr) {

            if (error && error.code !== self.exitCode) {
                self.hasBeenKilled = true;
                logger.error('Error Running ChildProcess.', {
                    file: self.file,
                    argv: self.args,
                    stdout: stdout,
                    stderr: stderr,
                    error: error
                });

                self.reject(error);
            } else {
                self.hasBeenKilled = true;
                self.resolve({
                    stdout: stdout,
                    stderr: stderr
                });
            }
        })
        .on('close', function(code, signal) {
            if (signal) {
                logger.warning("Child process received closing signal:", {
                    signal: signal,
                    argv: self.args
                });
            }
            self.hasBeenKilled = true;
        })
        .on('error', function(code, signal) {
            logger.error("Child process received closing signal but has " +
                "already been closed!!!", {
                signal: signal,
                argv: self.args
            });
        });
    };

    ChildProcess.prototype.run = function(options) {
        var self = this;
        options = options || {};
        options.retries = options.retries || 0;

        function _runWithRetries(retryCount) {
            self._run();

            return self._deferred.promise.catch(function(e) {
                if (e.name === 'JobKilledError') {
                    throw e;
                } else if (retryCount < options.retries) {
                    logger.debug("Retrying ChildProcess command.", {
                        error: e
                    });
                    self._deferred = Q.defer();
                    return _runWithRetries(retryCount + 1);
                } else {
                    throw e;
                }
            });
        }

        return _runWithRetries(0);
    };

    /**
     * Internal method to identify the path to the command file.  It's essentially
     * unix which in JavaScript.
     * @private
     */
    ChildProcess.prototype._parseCommandPath = function _parseCommandPath (command) {
        var self = this;

        if (self._fileExists(command)) {
            return command;
        } else {
            var found = _.some(self._getPaths(), function (current) {
                var target = path.resolve(current + '/' + command);

                if (self._fileExists(target)) {
                    command = target;

                    return true;
                }
            });

            return found ? command : null;
        }
    };

    /**
     * Internal method to verify a file exists and is not a directory.
     * @private
     */
    ChildProcess.prototype._fileExists = function _fileExists (file) {
        return fs.existsSync(file) && !fs.statSync(file).isDirectory();
    };

    /**
     * Internal method to get an array of directories in the users path.
     * @private
     */
    ChildProcess.prototype._getPaths = function _getPaths () {
        var path = process.env.path || process.env.Path || process.env.PATH;
        return path.split(':');
    };

    ChildProcess.JobKilledError = JobKilledError;

    return ChildProcess;
}