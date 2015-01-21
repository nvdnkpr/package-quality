'use strict';

/**
 * Read info about a package and estimate its quality.
 * (C) 2014 Alex Fernández.
 */

// requires
require('prototypes');
var config = require('../config.js');
var request = require('request');
var moment = require('moment');
var async = require('async');
var testing = require('testing');
var Log = require('log');

// globals
var log = new Log(config.logLevel);


/**
 * Estimate the quality of a package.
 */
exports.estimate = function(entry, callback)
{
	if (!entry || !entry.name)
	{
		log.error('null entry or entry without name: ' + JSON.stringify(entry));
		return callback(JSON.stringify(entry) + ' is null or has no name');
	}
	var waterfall = [
		// estimate repo 
		function(callback)
		{
			return estimateRepo(entry.repository, callback);
		},
		// estimate downloads ONLY if estimateRepo returned quality > 0.0
		function(consolidatedQuality, callback)
		{
			log.debug('Repo consolidated quality: %s', consolidatedQuality);
			if (consolidatedQuality > 0) {
				estimateDownloadsLastYear(entry.name, function(error, downloadsQuality)
				{
					if (error)
					{
						return callback(error);
					}
					return callback(null, consolidatedQuality * downloadsQuality);
				});
			}
			else
			{
				return callback(null, consolidatedQuality);
			}
		},
		// call registry URL ONLY if estimateRepo returned quality > 0.0
		function(consolidatedQuality, callback)
		{
			log.debug('Downloads consolidated quality: %s', consolidatedQuality);
			if (consolidatedQuality > 0)
			{
				var url = 'http://registry.npmjs.org/' + entry.name;
				log.debug('Registry URL: %s', url);
				request.get(url, function(error, response, body)
				{
					if (error)
					{
						if (response.statusCode == 404)
						{
							return callback(null, 0, null);
						}
						log.error('Could not read registry for ' + entry.name + ' (' + url + '): ' + error);
						return callback(null, 0, null);
					}
					var registryResponse;
					try
					{
						registryResponse = JSON.parse(body);
					}
					catch(exception)
					{
						log.debug('Could not parse ' + entry.name + ' registry response: ' + exception);
						return callback(null, 0, null);
					}
					return callback(null, consolidatedQuality, registryResponse);
				});
			}
			else
			{
				return callback(null, consolidatedQuality, null);
			}
		},
		// estimate version ONLY if consolidatedQuality > 0
		function(consolidatedQuality, registryResponse, callback)
		{
			log.debug('Downloads consolidated quality: %s', consolidatedQuality);
			if (consolidatedQuality > 0)
			{
				estimateVersions(registryResponse.versions, function(error, versionQuality)
				{
					if (error)
					{
						return callback(error);
					}
					callback(null, consolidatedQuality * versionQuality);
				});
			}
			else
			{
				return callback (null, consolidatedQuality);
			}
		}
	];
	// launch waterfall
	async.waterfall(waterfall, callback);
};

function estimateVersions(versions, callback)
{
	if (!versions)
	{
		return callback(null, 0);
	}
	var number = versions.countProperties();
	log.debug('Versions %s', number);
	return callback(null, 1 - 1 / number);
}

function estimateDownloadsLastYear(name, callback) {
	var now = moment();
	var aYearAgo = now.clone().subtract(1,'year');
	var url = 'http://npm-stat.com/downloads/range/' + aYearAgo.format('YYYY-MM-DD') + ':' + now.format('YYYY-MM-DD') + '/' + name;
	log.debug('Downloads URL: %s', url);
	request.get(url, function(error, response, body) {
		if (error)
		{
			if (response.statusCode == 404)
			{
				return callback(null, 0);
			}
			log.error('Could not read downloads for ' + name + ' (' + url + '): ' + error);
			return callback(null, 0);
		}
		var result;
		try
		{
			result = JSON.parse(body);
		}
		catch(exception)
		{
			return callback('Could not parse ' + name + ': ' + exception);
		}
		var quality = 0;
		if ('downloads' in result) {
			var downloads = 0;
			result.downloads.forEach(function(item) {
				downloads += item.downloads;
			});
			log.debug('Downloads %s', downloads);
			quality = 1 - 1/downloads;
		}
		return callback(null, quality);
	});

}

function estimateRepo(repo, callback)
{
	log.debug('estimateRepo %j', repo);
	var info = extractRepoInfo(repo);
	if (!info || !info.valid)
	{
		log.debug('Invalid or null repo: ' + JSON.stringify(repo));
		return callback(null, 0);
	}
	var issuesUrl = 'https://api.github.com/repos/' + info.owner + '/' + info.name + '/issues?per_page=1000&state=all';
	log.debug('URL for issues: %s', issuesUrl);
	request({method:'GET', uri:issuesUrl, headers:{'User-Agent':'node.js'}, auth:{user:"4955253efa98c4eebaad3147104bbf1e4a1d5f6c"}}, function(error, response, body)
	{
		if (error)
		{
			log.error('Could not access issues on ' + issuesUrl + ': ' + error);
			return callback(null, 0);
		}
		var issues;
		try
		{
			issues = JSON.parse(body);
		}
		catch(exception)
		{
			return callback('Invalid issues in ' + body + ': ' + exception);
		}
		var open = 0;
		var closed = 0;
		var total = 0;
		issues.forEach(function(issue)
		{
			total += 1;
			if (issue.state == 'open')
			{
				open += 1;
			}
			else if (issue.state == 'closed')
			{
				closed += 1;
			}
			else
			{
				log.error('Invalid state %s', issue.state);
			}
		});
		if (!total)
		{
			log.debug('No issues in %s', issues);
			return callback(null, 0);
		}
		log.debug('Issues: %s / %s open', open, total);
		return callback(null, 1 - open / total);
	});
}

function extractRepoInfo(repo)
{
	log.debug('extractRepoInfo %j', repo);
	if (!repo || !repo.type || !repo.url)
	{
		log.debug('Incomplete repo. Returning null info.');
		return null;
	}
	if (repo.type != 'git')
	{
		log.error('Invalid repo type: %s', repo.type);
		return null;
	}
	if (repo.url.startsWith('git@github.com:'))
	{
		return extractPieces(repo.url.substringFrom('git@github.com:'), 0);
	}
	if (repo.url.startsWith('git://github.com:'))
	{
		return extractPieces(repo.url.substringFrom('git://github.com:'), 0);
	}
	return extractPieces(repo.url, 3);
}

function extractPieces(remaining, initial)
{
	var pieces = remaining.split('/');
	if (pieces.length != initial + 2)
	{
		log.error('Invalid URL %s', remaining);
		return {};
	}
	return {
		valid: true,
		owner: pieces[initial],
		name: pieces[initial + 1].substringUpTo('.git'),
	};
}

/**
 * Unit tests.
 */

function testEstimation(callback)
{
	var entry = require('../test/test_entry.json');
	exports.estimate(entry, function(error, result)
	{
		testing.check(error, 'Could not read %s', entry.name, callback);
		testing.assert(result, 'No result', callback);
		testing.assert(result > 0, 'the test entry has to return a positive quality', callback);
		testing.success(callback);
	});
}

/**
 * Run all tests.
 */
exports.test = function(callback)
{
	testing.run([
		testEstimation,
	], 10000, callback);
};

// run tests if invoked directly
if (__filename == process.argv[1])
{
	exports.test(testing.show);
}
