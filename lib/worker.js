/* eslint-disable no-var */
var json1 = require('ot-json1');
var types = require('./types');
var ot = require('./ot');
var Delta = require('quill-delta');

var richText = {
  type: {
    name: 'rich-text',
    uri: 'http://sharejs.org/types/rich-text/v1',

    create: function(initial) {
      return new Delta(initial);
    },

    apply: function(snapshot, delta) {
      var snapshotD = new Delta(snapshot);
      var deltaD = new Delta(delta);
      return snapshotD.compose(deltaD).ops;
    },

    compose: function(delta1, delta2) {
      var delta1D = new Delta(delta1);
      var delta2D = new Delta(delta2);
      return delta1D.compose(delta2D).ops;
    },

    diff: function(delta1, delta2) {
      var delta1D = new Delta(delta1);
      var delta2D = new Delta(delta2);
      return delta1D.diff(delta2D).ops;
    },

    transform: function(delta1, delta2, side) {
      var delta1D = new Delta(delta1);
      var delta2D = new Delta(delta2);
      // Fuzzer specs is in opposite order of delta interface
      return delta2D.transform(delta1D, side === 'left').ops;
    },

    transformCursor: function(cursor, delta, isOwnOp) {
      return delta.transformPosition(cursor, !isOwnOp);
    },

    normalize: function(delta) {
      return delta; // quill-delta is already canonical
    },

    serialize: function(delta) {
      return delta.ops;
    },

    deserialize: function(ops) {
      return ops;
    },

    transformPresence: function(range, op, isOwnOp) {
      if (!range) {
        return null;
      }

      var delta = new Delta(op);
      var start = this.transformCursor(range.index, delta, isOwnOp);
      var end = this.transformCursor(range.index + range.length, delta, isOwnOp);

      // return {
      //   ...range,
      //   index: start,
      //   length: end - start,
      // };
      return Object.assign({}, range, {index: start, length: end-start});
    }
  }
};

json1.type.name = 'ot-json1';
json1.type.registerSubtype(richText.type);
json1.invert = null;
types.register(json1.type);

function apply(param) {
  var start = Date.now();
  var snapshot = param.snapshot;
  var op = param.op;
  var err = ot.apply(snapshot, op);
  var spent = Date.now() - start;
  if (err) throw err;
  return {snapshot: snapshot, op: op, spent: spent};
}

function transform(param) {
  var start = Date.now();
  var type = param.type;
  var op = param.op;
  var appliedOp = param.appliedOp;
  var err = ot.transform(type, op, appliedOp);
  var spent = Date.now() - start;
  if (err) throw err;
  return {op: op, spent: spent};
}

module.exports = {apply: apply, transform: transform};
