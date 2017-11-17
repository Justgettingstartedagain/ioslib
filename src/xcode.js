import fs from 'fs';
import options from './options';
import path from 'path';
import plist from 'simple-plist';
import Simctl from './simctl';
import version from './version';

import { arrayify, cache, get } from 'appcd-util';
import { devicePairCompatibility } from './simulator';
import { expandPath } from 'appcd-path';
import { isDir, isFile } from 'appcd-fs';
import { run, which } from 'appcd-subprocess';
import { spawnSync } from 'child_process';

/**
 * Directories to scan for Xcode installations.
 * @type {Array.<String>}
 */
export const xcodeLocations = [
	'/Applications',
	'~/Applications'
];

/**
 * The path to the global directory containing the device types and runtimes. This is mostly for
 * legacy Xcode versions. Newer versions install runtimes in Xcode app directory.
 * @type {String}
 */
export const globalSimProfilesPath = '/Library/Developer/CoreSimulator/Profiles';

/**
 * Xcode information object.
 */
export class Xcode {
	/**
	 * Checks if the specified directory is an Xcode.
	 *
	 * @param {String} dir - The directory to check.
	 * @access public
	 */
	constructor(dir) {
		if (typeof dir !== 'string' || !dir) {
			throw new TypeError('Expected directory to be a valid string');
		}

		dir = expandPath(dir);
		if (!isDir(dir)) {
			throw new Error('Directory does not exist');
		}

		let xcodebuild = path.join(dir, 'usr', 'bin', 'xcodebuild');
		if (!isFile(xcodebuild)) {
			xcodebuild = path.join(dir, 'Developer', 'usr', 'bin', 'xcodebuild');
		}
		if (!isFile(xcodebuild)) {
			xcodebuild = path.join(dir, 'Contents', 'Developer', 'usr', 'bin', 'xcodebuild');
		}
		if (!isFile(xcodebuild)) {
			throw new Error('"xcodebuild" not found');
		}

		// now that we've found xcodebuild, trim off all the directories to get us to the Xcode path
		dir = path.resolve(path.dirname(xcodebuild), '../..');

		const versionPlistFile = path.resolve(dir, '../version.plist');
		if (!isFile(versionPlistFile)) {
			throw new Error('"version.plist" not found');
		}
		const versionPlist = plist.readFileSync(versionPlistFile);

		if (version.lt(versionPlist.CFBundleShortVersionString, 6)) {
			throw new Error(`Found Xcode ${versionPlist.CFBundleShortVersionString}, but it is too old and unsupported`);
		}

		this.path         = dir;
		this.xcodeapp     = path.resolve(dir, '../..');
		this.version      = versionPlist.CFBundleShortVersionString;
		this.build        = versionPlist.ProductBuildVersion;
		this.id           = `${this.version}:${this.build}`;
		this.executables = {
			simulator:      null,
			watchsimulator: null,
			xcodebuild
		};
		this.eulaAccepted = spawnSync(xcodebuild, [ '-checkFirstLaunchStatus' ]).status === 0;
		this.sdks = {
			ios:     this.findSDKs('iPhoneOS'),
			watchos: this.findSDKs('WatchOS')
		};
		this.simctl = new Simctl(path.join(dir, 'usr/bin/simctl'));
		this.simDeviceTypes = {};
		this.simRuntimes    = {};
		this.simDevicePairs = {};

		for (const xcodeRange of Object.keys(devicePairCompatibility)) {
			if (version.satisfies(this.version, xcodeRange)) {
				this.simDevicePairs = devicePairCompatibility[xcodeRange];
				break;
			}
		}

		// loop over the names and scan the derived path for simulator device types and runtimes
		// note: Xcode 9 moved CoreSimulator into the "xxxxOS" directory instead of the "xxxxSimulator" directory
		this.findDeviceTypesAndRuntimes(globalSimProfilesPath);
		for (const name of [ 'iPhoneSimulator', 'iPhoneOS', 'WatchSimulator', 'WatchOS' ]) {
			this.findDeviceTypesAndRuntimes(path.join(this.path, `Platforms/${name}.platform/Developer/Library/CoreSimulator/Profiles`));
		}

		for (const name of [ 'Simulator', 'iOS Simulator' ]) {
			const app = path.join(this.path, `Applications/${name}.app/Contents/MacOS/${name}`);
			if (isFile(app)) {
				this.executables.simulator = app;
				break;
			}
		}

		if (version.gte(this.version, 9)) {
			// there's no more watch simulator
			this.executables.watchsimulator = this.executables.simulator;
		} else {
			const app = path.join(dir, 'Applications/Simulator (Watch).app/Contents/MacOS/Simulator (Watch)');
			if (isFile(app)) {
				this.executables.watchsimulator = app;
			}
		}
	}

	/**
	 * Detects all SDK versions in the current Xcode path and the specified SDK type name.
	 *
	 * @param {String} sdkTypeName - The name of the SDK to scan.
	 * @returns {Array.<String>}
	 * @access private
	 */
	findSDKs(sdkTypeName) {
		const dir = path.join(this.path, `Platforms/${sdkTypeName}.platform/Developer/SDKs`);

		if (!isDir(dir)) {
			return [];
		}

		const nameRegExp = new RegExp(`^${sdkTypeName}(.*).sdk$`);
		const results = new Set();

		for (const name of fs.readdirSync(dir)) {
			const m = name.match(nameRegExp);
			const subdir = m && path.join(dir, name);
			if (!m || !isDir(subdir)) {
				continue;
			}
			let ver = m[1] || null;
			try {
				const plistFile = path.join(subdir, 'System/Library/CoreServices/SystemVersion.plist');
				const info = plist.readFileSync(plistFile);
				if (info.ProductVersion) {
					ver = info.ProductVersion;
				}
			} catch (e) {
				// squelch
			}
			results.add(ver);
		}

		return Array.from(results).sort(version.rcompare);
	}

	/**
	 * Finds all simulator device types and runtimes in the given Xcode dir.
	 *
	 * @param {String} dir - The directory to scan for device types and runtimes.
	 * @access private
	 */
	findDeviceTypesAndRuntimes(dir) {
		if (!isDir(dir)) {
			return;
		}

		// device types
		const deviceTypesDir = path.join(dir, 'DeviceTypes');
		if (isDir(deviceTypesDir)) {
			for (const name of fs.readdirSync(deviceTypesDir)) {
				try {
					let info = plist.readFileSync(path.join(deviceTypesDir, name, 'Contents/Info.plist'));
					const deviceType = {
						name: info.CFBundleName,
						model: 'unknown',
						supportsWatch: false
					};
					const id = info.CFBundleIdentifier;

					try {
						info = plist.readFileSync(path.join(deviceTypesDir, name, 'Contents/Resources/profile.plist'));
						if (info.modelIdentifier) {
							deviceType.model = info.modelIdentifier;
						}
					} catch (e) {
						// squelch
					}

					try {
						info = plist.readFileSync(path.join(deviceTypesDir, name, 'Contents/Resources/capabilities.plist'));
						deviceType.supportsWatch = !!info.capabilities['watch-companion'];
					} catch (e) {
						// squelch
					}

					this.simDeviceTypes[id] = deviceType;
				} catch (e) {
					// squelch
				}
			}
		}

		// runtimes
		const runtimesDir = path.join(dir, 'Runtimes');
		if (isDir(runtimesDir)) {
			for (const name of fs.readdirSync(runtimesDir)) {
				try {
					let info = plist.readFileSync(path.join(runtimesDir, name, 'Contents/Info.plist'));
					const runtime = {
						name: info.CFBundleName,
						version: null
					};
					const id = info.CFBundleIdentifier;

					try {
						info = plist.readFileSync(path.join(runtimesDir, name, 'Contents/Resources/profile.plist'));
						runtime.version = info.defaultVersionString;
					} catch (e) {
						// squelch
					}

					this.simRuntimes[id] = runtime;
				} catch (e) {
					// squelch
				}
			}
		}
	}
}

export default Xcode;

/**
 * Detects installed Xcodes, then caches and returns the results.
 *
 * @param {Object} [opts] - Various options.
 * @param {Boolean} [opts.force=false] - When `true`, bypasses cache and forces redetection.
 * @returns {Promise<Array.<Xcode>>}
 */
export function getXcodes({ force } = {}) {
	return cache('ioslib:xcode', force, () => {
		const results = {};
		const searchPaths = arrayify(get(options, 'xcode.searchPaths') || xcodeLocations, true);

		searchPaths.push('/Users/chris/Desktop/Xcode-8.3.3.app');

		for (let dir of searchPaths) {
			try {
				const xcode = new Xcode(dir);
				results[xcode.id] = xcode;
			} catch (e) {
				// not an Xcode, check subdirectories
				if (isDir(dir = expandPath(dir))) {
					for (const name of fs.readdirSync(dir)) {
						try {
							const xcode = new Xcode(path.join(dir, name));
							results[xcode.id] = xcode;
						} catch (e2) {
							// not an Xcode
						}
					}
				}
			}
		}

		return results;
	});
}

/**
 * Determines the default Xcode path by running `xcode-select`.
 *
 * @returns {Promise<String>}
 */
export async function getDefaultXcodePath() {
	try {
		const bin = await which(get(options, 'executables.xcodeselect') || 'xcode-select', {
			path: get(options, 'env.path')
		});
		const { stdout } = await run(bin, [ '--print-path' ]);
		return path.resolve(stdout.trim(), '../..');
	} catch (e) {
		return null;
	}
}
