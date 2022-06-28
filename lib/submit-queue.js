var assert = require('assert');

function SubmitQueues() {
  if (!(this instanceof SubmitQueues)) return new SubmitQueues();
  this._map = new Map();
}

SubmitQueues.prototype.getQueue = function(request) {
  var key = request.collection + request.id;
  var queue = this._map.get(key);
  if (!queue) {
    queue = new SubmitQueue();
    this._map.set(key, queue);
  }
  return queue;
};

SubmitQueues.prototype.enqueue = function(request, callback) {
  var queue = this.getQueue(request);
  queue.enqueue(request, callback);
};

SubmitQueues.prototype.dequeue = function(request, callback) {
  var queue = this.getQueue(request);
  queue.dequeue(request, callback);
};

function SubmitQueue() {
  if (!(this instanceof SubmitQueue)) return new SubmitQueue();
  this._requests = [];
  this._callbacks = [];
  this._request = undefined;
  this._callback = undefined;
}

SubmitQueue.prototype.enqueue = function(request, callback) {
  this._requests.push(request);
  this._callbacks.push(callback);
  this.run();
};

SubmitQueue.prototype.dequeue = function(request, callback) {
  assert(this._request === request, 'request not match');
  assert(this._callback === callback, 'callback not match');
  this._request = undefined;
  this._callback = undefined;
  this.run();
};

SubmitQueue.prototype.run = function() {
  if (this._request) return;
  if (this._requests.length === 0) return;
  this._request = this._requests.shift();
  this._callback = this._callbacks.shift();
  this._request.submitCore(this._callback);
};

var submitQueues = new SubmitQueues();
module.exports = submitQueues;
