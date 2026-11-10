// Source-only hidden GUI guard: record requests/clicks without contacting the OS.
const { EventEmitter } = require('node:events');
const Module = require('node:module'), load = Module._load, electron = require('electron');
const cp = require('node:child_process'), spawn = cp.spawn;
cp.spawn = function (executable, args, ...options) {
  if (args?.some(arg => typeof arg === 'string' && /(?:^|[\\/])daemon\.cjs$/.test(arg))) throw Error('Decision fixture forbids real daemon bootstrap');
  return spawn.call(this, executable, args, ...options);
};
globalThis.decisionNotifications = [];
class FixtureNotification extends EventEmitter {
  static isSupported() { return true; }
  constructor(options) { super(); this.options = options; }
  show() { globalThis.decisionNotifications.push(this); }
}
const wrapped = Object.create(electron, { Notification: { value: FixtureNotification } });
Module._load = function (name, ...args) { return name === 'electron' ? wrapped : load.call(this, name, ...args); };
