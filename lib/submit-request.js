var ot = require('./ot');
var projections = require('./projections');
var ShareDBError = require('./error');
var SubmitQueues = require('./submit-queue');
var Piscina = require('piscina');
var path = require('path');

var piscina = new Piscina({
  filename: path.join(__dirname, 'worker.js'),
  idleTimeout: 3600000
});

var ERROR_CODE = ShareDBError.CODES;

function SubmitRequest(backend, agent, index, id, op, options) {
  this.backend = backend;
  this.agent = agent;
  // If a projection, rewrite the call into a call against the collection
  var projection = backend.projections[index];
  this.index = index;
  this.projection = projection;
  this.collection = (projection) ? projection.target : index;
  this.id = id;
  this.op = op;
  this.options = options;

  this.extra = op.x;
  delete op.x;

  this.start = Date.now();
  this._addOpMeta();

  // Set as this request is sent through middleware
  this.action = null;
  // For custom use in middleware
  this.custom = {};

  // Whether or not to store a milestone snapshot. If left as null, the milestone
  // snapshots are saved according to the interval provided to the milestone db
  // options. If overridden to a boolean value, then that value is used instead of
  // the interval logic.
  this.saveMilestoneSnapshot = null;
  this.suppressPublish = backend.suppressPublish;
  this.maxRetries = backend.maxSubmitRetries;
  this.retries = 0;

  // return values
  this.snapshot = null;
  this.ops = [];
  this.channels = null;
}
module.exports = SubmitRequest;

SubmitRequest.prototype.submit = function(callback) {
  var request = this;
  var wrappedCallback = function(err) {
    SubmitQueues.dequeue(request, wrappedCallback);
    callback(err);
  };
  SubmitQueues.enqueue(request, wrappedCallback);
};

SubmitRequest.prototype.submitCore = function(callback) {
  var request = this;
  var backend = this.backend;
  var collection = this.collection;
  var id = this.id;
  var op = this.op;
  // Send a special projection so that getSnapshot knows to return all fields.
  // With a null projection, it strips document metadata
  var fields = {$submit: true};

  var snapshotOptions = {};
  snapshotOptions.agentCustom = request.agent.custom;
  backend.db.getSnapshot(collection, id, fields, snapshotOptions, function(err, snapshot) {
    if (err) return callback(err);

    request.snapshot = snapshot;
    request._addSnapshotMeta();

    if (op.v == null) {
      if (op.create && snapshot.type && op.src) {
        // If the document was already created by another op, we will return a
        // 'Document already exists' error in response and fail to submit this
        // op. However, this could also happen in the case that the op was
        // already committed and the create op was simply resent. In that
        // case, we should return a non-fatal 'Op already submitted' error. We
        // must get the past ops and check their src and seq values to
        // differentiate.
        backend.db.getCommittedOpVersion(collection, id, snapshot, op, null, function(err, version) {
          if (err) return callback(err);
          if (version == null) {
            callback(request.alreadyCreatedError());
          } else {
            op.v = version;
            callback(request.alreadySubmittedError());
          }
        });
        return;
      }

      // Submitting an op with a null version means that it should get the
      // version from the latest snapshot. Generally this will mean the op
      // won't be transformed, though transform could be called on it in the
      // case of a retry from a simultaneous submit
      op.v = snapshot.v;
    }

    if (op.v === snapshot.v) {
      // The snapshot hasn't changed since the op's base version. Apply
      // without transforming the op
      return request.apply(callback);
    }

    if (op.v > snapshot.v) {
      // The op version should be from a previous snapshot, so it should never
      // never exceed the current snapshot's version
      return callback(request.newerVersionError());
    }

    // Transform the op up to the current snapshot version, then apply
    var from = op.v;
    backend.db.getOpsToSnapshot(collection, id, from, snapshot, null, function(err, ops) {
      if (err) return callback(err);

      if (ops.length !== snapshot.v - from) {
        return callback(request.missingOpsError());
      }

      request._transformOp(ops, function(err) {
        if (err) return callback(err);

        if (request.op.v !== snapshot.v) {
          // This shouldn't happen, but is just a final sanity check to make
          // sure we have transformed the op to the current snapshot version
          return callback(request.versionAfterTransformError());
        }

        request.apply(callback);
      });
    });
  });
};

SubmitRequest.prototype.apply = function(callback) {
  // If we're being projected, verify that the op is allowed
  var projection = this.projection;
  if (projection && !projections.isOpAllowed(this.snapshot.type, projection.fields, this.op)) {
    return callback(this.projectionError());
  }

  // Always set the channels before each attempt to apply. If the channels are
  // modified in a middleware and we retry, we want to reset to a new array
  this.channels = this.backend.getChannels(this.collection, this.id);

  var request = this;
  this.backend.trigger(this.backend.MIDDLEWARE_ACTIONS.apply, this.agent, this, function(err) {
    if (err) return callback(err);

    // Apply the submitted op to the snapshot
    request._applyOp(function(err) {
      if (err) return callback(err);
      request.commit(callback);
    });
  });
};

SubmitRequest.prototype._applyOp = function(callback) {
  if (this.shouldWorkInWorker()) {
    var request = this;
    var start = Date.now();
    piscina.run({snapshot: this.snapshot, op: this.op}, {name: 'apply'})
      .then(function(result) {
        var total = Date.now() - start;
        console.info(
          'piscina run apply %d ops took total %d ms, working %d ms, waste %d ms',
          request.op.op.length, total, result.spent, total - result.spent);
        //
        request.snapshot = result.snapshot;
        //
        callback();
      })
      .catch(function(err) {
        callback(err);
      });
  } else {
    err = ot.apply(this.snapshot, this.op);
    callback(err);
  }
};

SubmitRequest.prototype.shouldWorkInWorker = function() {
  var workerThreshold = this.backend.workerThreshold;
  var opLength = (this.op.op && this.op.op.length) || 0;
  return workerThreshold && opLength > workerThreshold;
};

SubmitRequest.prototype.commit = function(callback) {
  var request = this;
  var backend = this.backend;
  backend.trigger(backend.MIDDLEWARE_ACTIONS.commit, this.agent, this, function(err) {
    if (err) return callback(err);

    // Try committing the operation and snapshot to the database atomically
    backend.db.commit(
      request.collection,
      request.id,
      request.op,
      request.snapshot,
      request.options,
      function(err, succeeded) {
        if (err) return callback(err);
        if (!succeeded) {
          // Between our fetch and our call to commit, another client committed an
          // operation. We expect this to be relatively infrequent but normal.
          return request.retry(callback);
        }
        if (!request.suppressPublish) {
          var op = request.op;
          op.c = request.collection;
          op.d = request.id;
          op.m = undefined;
          // Needed for agent to detect if it can ignore sending the op back to
          // the client that submitted it in subscriptions
          if (request.collection !== request.index) op.i = request.index;
          backend.pubsub.publish(request.channels, op);
        }
        if (request._shouldSaveMilestoneSnapshot(request.snapshot)) {
          request.backend.milestoneDb.saveMilestoneSnapshot(request.collection, request.snapshot);
        }
        callback();
      });
  });
};

SubmitRequest.prototype.retry = function(callback) {
  this.retries++;
  if (this.maxRetries != null && this.retries > this.maxRetries) {
    return callback(this.maxRetriesError());
  }
  this.backend.emit('timing', 'submit.retry', Date.now() - this.start, this);
  this.submitCore(callback);
};

SubmitRequest.prototype._transformOp = function(ops, callback) {
  if (ops.length === 0) return callback();
  var type = this.snapshot.type;
  var appliedOp = ops.shift();
  if (this.op.src && this.op.src === appliedOp.src && this.op.seq === appliedOp.seq) {
    // The op has already been submitted. There are a variety of ways this
    // can happen in normal operation, such as a client resending an
    // unacknowledged operation at reconnect. It's important we don't apply
    // the same op twice
    return callback(this.alreadySubmittedError());
  }

  if (this.op.v !== appliedOp.v) {
    return callback(this.versionDuringTransformError());
  }

  var request = this;
  this._transformOpCore(type, this.op, appliedOp, function(err) {
    if (err) return callback(err);
    request.ops.push(appliedOp);
    request._transformOp(ops, callback);
  });
};

SubmitRequest.prototype._transformOpCore = function(type, op, appliedOp, callback) {
  var request = this;
  if (this.shouldWorkInWorker()) {
    var start = Date.now();
    piscina
      .run({type: type, op: op, appliedOp: appliedOp}, {name: 'transform'})
      .then(function(result) {
        var total = Date.now() - start;
        console.info(
          'piscina run transform %d ops took total %d ms, working %d ms, waste %d ms',
          request.op.op.length, total, result.spent, total - result.spent);
        //
        request.op.op = result.op.op;
        request.op.v = result.op.v;
        //
        callback();
      })
      .catch(function(err) {
        callback(err);
      });
  } else {
    var err = ot.transform(type, op, appliedOp);
    if (err) return callback(err);
    callback();
  }
};

SubmitRequest.prototype._addOpMeta = function() {
  this.op.m = {
    ts: this.start
  };
  if (this.op.create) {
    // Consistently store the full URI of the type, not just its short name
    this.op.create.type = ot.normalizeType(this.op.create.type);
  }
};

SubmitRequest.prototype._addSnapshotMeta = function() {
  var meta = this.snapshot.m || (this.snapshot.m = {});
  if (this.op.create) {
    meta.ctime = this.start;
  } else if (this.op.del) {
    this.op.m.data = this.snapshot.data;
  }
  meta.mtime = this.start;
};

SubmitRequest.prototype._shouldSaveMilestoneSnapshot = function(snapshot) {
  // If the flag is null, it's not been overridden by the consumer, so apply the interval
  if (this.saveMilestoneSnapshot === null) {
    return snapshot && snapshot.v % this.backend.milestoneDb.interval === 0;
  }

  return this.saveMilestoneSnapshot;
};

// Non-fatal client errors:
SubmitRequest.prototype.alreadySubmittedError = function() {
  return new ShareDBError(ERROR_CODE.ERR_OP_ALREADY_SUBMITTED, 'Op already submitted');
};
SubmitRequest.prototype.rejectedError = function() {
  return new ShareDBError(ERROR_CODE.ERR_OP_SUBMIT_REJECTED, 'Op submit rejected');
};
// Fatal client errors:
SubmitRequest.prototype.alreadyCreatedError = function() {
  return new ShareDBError(ERROR_CODE.ERR_DOC_ALREADY_CREATED, 'Invalid op submitted. Document already created');
};
SubmitRequest.prototype.newerVersionError = function() {
  return new ShareDBError(
    ERROR_CODE.ERR_OP_VERSION_NEWER_THAN_CURRENT_SNAPSHOT,
    'Invalid op submitted. Op version newer than current snapshot'
  );
};
SubmitRequest.prototype.projectionError = function() {
  return new ShareDBError(
    ERROR_CODE.ERR_OP_NOT_ALLOWED_IN_PROJECTION,
    'Invalid op submitted. Operation invalid in projected collection'
  );
};
// Fatal internal errors:
SubmitRequest.prototype.missingOpsError = function() {
  return new ShareDBError(
    ERROR_CODE.ERR_SUBMIT_TRANSFORM_OPS_NOT_FOUND,
    'Op submit failed. DB missing ops needed to transform it up to the current snapshot version'
  );
};
SubmitRequest.prototype.versionDuringTransformError = function() {
  return new ShareDBError(
    ERROR_CODE.ERR_OP_VERSION_MISMATCH_DURING_TRANSFORM,
    'Op submit failed. Versions mismatched during op transform'
  );
};
SubmitRequest.prototype.versionAfterTransformError = function() {
  return new ShareDBError(
    ERROR_CODE.ERR_OP_VERSION_MISMATCH_AFTER_TRANSFORM,
    'Op submit failed. Op version mismatches snapshot after op transform'
  );
};
SubmitRequest.prototype.maxRetriesError = function() {
  return new ShareDBError(
    ERROR_CODE.ERR_MAX_SUBMIT_RETRIES_EXCEEDED,
    'Op submit failed. Exceeded max submit retries of ' + this.maxRetries
  );
};
