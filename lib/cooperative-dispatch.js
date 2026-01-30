/*!
 * express
 * Copyright(c) 2009-2013 TJ Holowaychuk
 * Copyright(c) 2013 Roman Shtylman
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */

var onFinished = require('on-finished');

/**
 * Default configuration for cooperative dispatch.
 * @private
 */

var defaults = {
  // Maximum number of synchronous middleware/layer executions before yielding
  layerBudget: 50,
  // Maximum elapsed time (ms) before yielding
  timeBudget: 2,
  // Maximum yields per request (safety valve to prevent infinite loops)
  maxYields: 1000
};

/**
 * Symbol for storing cooperative dispatch state on request.
 * @private
 */

var cooperativeStateSymbol = '@@symbol:cooperative_dispatch_state';

/**
 * Create cooperative dispatch state for a request.
 * This tracks the budget and yield count per-request.
 *
 * @param {Object} options Configuration options
 * @return {Object} Cooperative dispatch state
 * @private
 */

function createState(options) {
  var opts = options || {};
  return {
    layerBudget: opts.layerBudget != null ? opts.layerBudget : defaults.layerBudget,
    timeBudget: opts.timeBudget != null ? opts.timeBudget : defaults.timeBudget,
    maxYields: opts.maxYields != null ? opts.maxYields : defaults.maxYields,
    layerCount: 0,
    yieldCount: 0,
    startTime: Date.now(),
    lastYieldTime: Date.now(),
    aborted: false
  };
}

/**
 * Get or create cooperative dispatch state for a request.
 *
 * @param {IncomingMessage} req
 * @param {Object} options Configuration options
 * @return {Object} Cooperative dispatch state
 * @private
 */

function getState(req, options) {
  if (!req[cooperativeStateSymbol]) {
    req[cooperativeStateSymbol] = createState(options);
  }
  return req[cooperativeStateSymbol];
}

/**
 * Reset the budget for the current dispatch cycle.
 * Called after yielding to prepare for the next batch of layers.
 *
 * @param {Object} state Cooperative dispatch state
 * @private
 */

function resetBudget(state) {
  state.layerCount = 0;
  state.lastYieldTime = Date.now();
}

/**
 * Check if the budget has been exceeded and we should yield.
 *
 * @param {Object} state Cooperative dispatch state
 * @return {boolean} True if we should yield
 * @private
 */

function shouldYield(state) {
  // Don't yield if we've hit the max yields (safety valve)
  if (state.yieldCount >= state.maxYields) {
    return false;
  }

  // Check layer count budget
  if (state.layerCount >= state.layerBudget) {
    return true;
  }

  // Check time budget
  var elapsed = Date.now() - state.lastYieldTime;
  if (elapsed >= state.timeBudget) {
    return true;
  }

  return false;
}

/**
 * Increment the layer count in the state.
 *
 * @param {Object} state Cooperative dispatch state
 * @private
 */

function incrementLayerCount(state) {
  state.layerCount++;
}

/**
 * Mark that we yielded and reset budget.
 *
 * @param {Object} state Cooperative dispatch state
 * @private
 */

function markYield(state) {
  state.yieldCount++;
  resetBudget(state);
}

/**
 * Check if the request has been aborted.
 *
 * @param {Object} state Cooperative dispatch state
 * @return {boolean} True if aborted
 * @private
 */

function isAborted(state) {
  return state.aborted;
}

/**
 * Mark the request as aborted.
 *
 * @param {Object} state Cooperative dispatch state
 * @private
 */

function markAborted(state) {
  state.aborted = true;
}

/**
 * Setup abort detection for a request.
 * This ensures dispatch stops if the client disconnects.
 *
 * @param {IncomingMessage} req
 * @param {Object} state Cooperative dispatch state
 * @private
 */

function setupAbortDetection(req, state) {
  // Track if abort handler has been setup
  if (state._abortSetup) {
    return;
  }
  state._abortSetup = true;

  // Listen for client disconnect (socket close before response)
  // We use 'close' event on the request which fires on client abort
  var onClose = function() {
    // Only mark as aborted if response hasn't started
    // This handles the case where client disconnects mid-processing
    if (req.res && !req.res.writableEnded) {
      markAborted(state);
    }
  };

  req.on('close', onClose);

  // Clean up listener when response finishes
  onFinished(req.res || req, function() {
    req.removeListener('close', onClose);
  });
}

/**
 * Create a cooperative next() wrapper.
 * This intercepts next() calls to check budget and yield when needed.
 *
 * @param {Function} originalNext The original next function
 * @param {Object} state Cooperative dispatch state
 * @return {Function} Wrapped next function
 * @private
 */

function wrapNext(originalNext, state) {
  var wrapped = function cooperativeNext(err) {
    // Check if request was aborted
    if (isAborted(state)) {
      // Don't continue dispatch after abort
      return;
    }

    // Increment layer count
    incrementLayerCount(state);

    // Check if we should yield
    if (shouldYield(state)) {
      markYield(state);

      // Use setImmediate to yield to event loop
      // This allows other I/O and timers to be processed
      var args = arguments;
      return setImmediate(function() {
        // Re-check abort state after yield
        if (isAborted(state)) {
          return;
        }
        originalNext.apply(null, args);
      });
    }

    // Continue synchronously
    return originalNext.apply(null, arguments);
  };

  // Preserve any properties on the original next function
  // (some code may check for properties on next)
  wrapped._cooperative = true;

  return wrapped;
}

/**
 * Wrap a middleware function to use cooperative dispatch.
 * This wraps the next() function passed to the middleware.
 *
 * @param {Function} fn The middleware function
 * @param {Object} options Configuration options
 * @return {Function} Wrapped middleware function
 * @private
 */

function wrapMiddleware(fn, options) {
  // Preserve arity for error handlers (which have 4 arguments)
  if (fn.length === 4) {
    // Error handler
    return function cooperativeErrorMiddleware(err, req, res, next) {
      var state = getState(req, options);

      // Setup abort detection if first middleware
      if (state.yieldCount === 0 && state.layerCount === 0) {
        setupAbortDetection(req, state);
      }

      // Check if aborted
      if (isAborted(state)) {
        return;
      }

      // Wrap next if not already wrapped
      var wrappedNext = next._cooperative ? next : wrapNext(next, state);

      return fn(err, req, res, wrappedNext);
    };
  } else {
    // Regular middleware
    return function cooperativeMiddleware(req, res, next) {
      var state = getState(req, options);

      // Setup abort detection if first middleware
      if (state.yieldCount === 0 && state.layerCount === 0) {
        setupAbortDetection(req, state);
      }

      // Check if aborted
      if (isAborted(state)) {
        return;
      }

      // Wrap next if not already wrapped
      var wrappedNext = next._cooperative ? next : wrapNext(next, state);

      return fn(req, res, wrappedNext);
    };
  }
}

/**
 * Module exports.
 */

module.exports = {
  defaults: defaults,
  createState: createState,
  getState: getState,
  resetBudget: resetBudget,
  shouldYield: shouldYield,
  incrementLayerCount: incrementLayerCount,
  markYield: markYield,
  isAborted: isAborted,
  markAborted: markAborted,
  setupAbortDetection: setupAbortDetection,
  wrapNext: wrapNext,
  wrapMiddleware: wrapMiddleware,
  cooperativeStateSymbol: cooperativeStateSymbol
};
