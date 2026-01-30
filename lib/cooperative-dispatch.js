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

var debug = require('debug')('express:cooperative-dispatch');

/**
 * Symbol for storing cooperative dispatch context on request
 * @private
 */

var DISPATCH_CONTEXT = Symbol('express.cooperativeDispatch');

/**
 * Default budget configuration
 * @public
 */

var DEFAULT_BUDGET = Object.freeze({
  maxTimeMs: 2,           // Max milliseconds per burst
  maxLayers: 50,          // Max layers per burst
  maxTotalYields: 100     // Max yields per request (safety valve)
});

/**
 * Module exports.
 * @public
 */

module.exports = {
  createDispatchContext: createDispatchContext,
  wrapAppHandle: wrapAppHandle,
  createCooperativeRouter: createCooperativeRouter,
  DEFAULT_BUDGET: DEFAULT_BUDGET
};

/**
 * Create a new dispatch context for tracking cooperative dispatch state.
 * This is stored per-request and tracks budget consumption.
 *
 * @param {Object} [budgetConfig] - Budget configuration
 * @param {number} [budgetConfig.maxTimeMs=2] - Max milliseconds per burst
 * @param {number} [budgetConfig.maxLayers=50] - Max layers per burst
 * @param {number} [budgetConfig.maxTotalYields=100] - Max yields per request
 * @return {Object} Dispatch context
 * @public
 */

function createDispatchContext(budgetConfig) {
  var config = budgetConfig || {};

  return {
    // Budget configuration (immutable for this request)
    maxTimeMs: typeof config.maxTimeMs === 'number' ? config.maxTimeMs : DEFAULT_BUDGET.maxTimeMs,
    maxLayers: typeof config.maxLayers === 'number' ? config.maxLayers : DEFAULT_BUDGET.maxLayers,
    maxTotalYields: typeof config.maxTotalYields === 'number' ? config.maxTotalYields : DEFAULT_BUDGET.maxTotalYields,

    // Current burst state (reset after each yield)
    burstStartTime: Date.now(),
    burstLayerCount: 0,

    // Request-lifetime counters
    totalYields: 0,
    totalLayers: 0,

    // Dispatch state
    yieldScheduled: false,
    routerDepth: 0
  };
}

/**
 * Get existing dispatch context from a request.
 *
 * @param {Object} req - Request object
 * @return {Object|null} Dispatch context or null
 * @public
 */

function getContext(req) {
  return req[DISPATCH_CONTEXT] || null;
}

/**
 * Set dispatch context on a request.
 *
 * @param {Object} req - Request object
 * @param {Object} ctx - Dispatch context
 * @private
 */

function setContext(req, ctx) {
  req[DISPATCH_CONTEXT] = ctx;
}

/**
 * Check if the dispatch budget is exhausted and we should yield.
 *
 * @param {Object} ctx - Dispatch context
 * @return {boolean} True if we should yield
 * @private
 */

function shouldYield(ctx) {
  // Safety valve: don't yield infinitely
  if (ctx.totalYields >= ctx.maxTotalYields) {
    debug('max yields reached (%d), continuing synchronously', ctx.totalYields);
    return false;
  }

  // Check time budget
  var elapsed = Date.now() - ctx.burstStartTime;
  if (elapsed >= ctx.maxTimeMs) {
    debug('time budget exhausted (%dms >= %dms)', elapsed, ctx.maxTimeMs);
    return true;
  }

  // Check layer count budget
  if (ctx.burstLayerCount >= ctx.maxLayers) {
    debug('layer budget exhausted (%d >= %d)', ctx.burstLayerCount, ctx.maxLayers);
    return true;
  }

  return false;
}

/**
 * Reset the burst budget after yielding.
 *
 * @param {Object} ctx - Dispatch context
 * @private
 */

function resetBurstBudget(ctx) {
  ctx.burstStartTime = Date.now();
  ctx.burstLayerCount = 0;
  ctx.totalYields++;
  ctx.yieldScheduled = false;
  debug('burst budget reset, total yields: %d', ctx.totalYields);
}

/**
 * Check if request is still active (not closed/destroyed).
 *
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @return {boolean} True if request is still active
 * @private
 */

function isRequestActive(req, res) {
  // Check various termination conditions
  if (req.destroyed) {
    return false;
  }

  if (res && (res.writableEnded || res.finished)) {
    return false;
  }

  if (req.socket && req.socket.destroyed) {
    return false;
  }

  return true;
}

/**
 * Wrap the app.handle method to add cooperative dispatch support.
 * This is the main integration point with Express.
 *
 * @param {Function} originalHandle - Original app.handle function
 * @param {Function} getBudgetConfig - Function to get budget config from app
 * @return {Function} Wrapped handle function
 * @public
 */

function wrapAppHandle(originalHandle, getBudgetConfig) {
  if (typeof originalHandle !== 'function') {
    throw new TypeError('originalHandle must be a function');
  }

  /**
   * Wrapped app handle with cooperative dispatch initialization.
   */
  return function cooperativeAppHandle(req, res, callback) {
    var app = this;

    // Check if cooperative dispatch is enabled
    if (!app.enabled('cooperative dispatch')) {
      // Not enabled, use original behavior
      return originalHandle.call(app, req, res, callback);
    }

    // Get budget configuration from app settings
    var budgetConfig = getBudgetConfig ? getBudgetConfig.call(app) : null;

    // Initialize dispatch context for this request
    var ctx = createDispatchContext(budgetConfig);
    setContext(req, ctx);

    debug('cooperative dispatch initialized for request');

    // Set up close/abort handling to stop dispatch if client disconnects
    var dispatchAborted = false;

    function onClose() {
      dispatchAborted = true;
      debug('request closed, dispatch will stop on next yield check');
    }

    // Listen for various termination events
    req.on('close', onClose);
    res.on('close', onClose);

    // Wrap the callback to clean up listeners
    var wrappedCallback = function(err) {
      req.removeListener('close', onClose);
      res.removeListener('close', onClose);

      debug('dispatch complete, total layers: %d, total yields: %d',
        ctx.totalLayers, ctx.totalYields);

      if (callback) {
        callback(err);
      }
    };

    // Call original handle
    originalHandle.call(app, req, res, wrappedCallback);
  };
}

/**
 * Create a cooperative router that wraps the standard Router.
 * This factory function creates a router with cooperative dispatch capabilities.
 *
 * @param {Function} Router - The Router constructor to wrap
 * @param {Object} [options] - Router options
 * @return {Object} Cooperative router instance
 * @public
 */

function createCooperativeRouter(Router, options) {
  var opts = options || {};
  var router = new Router(opts);

  // Store original use method
  var originalUse = router.use.bind(router);

  /**
   * Wrapped use method that instruments middleware for cooperative dispatch.
   */
  router.use = function cooperativeUse() {
    var args = Array.prototype.slice.call(arguments);
    var offset = 0;
    var path = '/';

    // Parse arguments (same logic as Router.prototype.use)
    if (typeof args[0] !== 'function') {
      var arg = args[0];
      while (Array.isArray(arg) && arg.length !== 0) {
        arg = arg[0];
      }
      if (typeof arg !== 'function') {
        offset = 1;
        path = args[0];
      }
    }

    // Wrap each middleware function
    var callbacks = Array.prototype.flat.call(args.slice(offset), Infinity);
    var wrappedCallbacks = callbacks.map(function(fn) {
      if (typeof fn !== 'function') {
        return fn; // Let router throw the error
      }
      return wrapMiddleware(fn);
    });

    // Call original use with wrapped middleware
    if (offset === 0) {
      return originalUse.apply(null, wrappedCallbacks);
    } else {
      return originalUse.apply(null, [path].concat(wrappedCallbacks));
    }
  };

  // Wrap route methods (get, post, etc.)
  var methods = require('./utils').methods;
  methods.forEach(function(method) {
    var originalMethod = router[method].bind(router);

    router[method] = function() {
      var args = Array.prototype.slice.call(arguments);
      var path = args[0];
      var callbacks = Array.prototype.flat.call(args.slice(1), Infinity);

      var wrappedCallbacks = callbacks.map(function(fn) {
        if (typeof fn !== 'function') {
          return fn;
        }
        return wrapMiddleware(fn);
      });

      return originalMethod.apply(null, [path].concat(wrappedCallbacks));
    };
  });

  return router;
}

/**
 * Wrap a middleware function to add cooperative dispatch checkpoints.
 *
 * @param {Function} fn - Original middleware function
 * @return {Function} Wrapped middleware function
 * @private
 */

function wrapMiddleware(fn) {
  var isErrorHandler = fn.length === 4;
  var fnName = fn.name || '<anonymous>';

  if (isErrorHandler) {
    // Error handling middleware (4 params)
    var wrappedErrorHandler = function cooperativeErrorMiddleware(err, req, res, next) {
      var ctx = getContext(req);

      // If no context or request not active, call original
      if (!ctx || !isRequestActive(req, res)) {
        if (!isRequestActive(req, res)) {
          debug('request inactive, skipping error middleware: %s', fnName);
          return;
        }
        return fn(err, req, res, next);
      }

      // Increment layer count
      ctx.burstLayerCount++;
      ctx.totalLayers++;

      debug('error middleware: %s (layer %d)', fnName, ctx.totalLayers);

      // Wrap next to add yield checkpoint
      var wrappedNext = createWrappedNext(ctx, req, res, next, fnName);

      // Call original middleware
      try {
        var result = fn(err, req, res, wrappedNext);
        handlePromiseResult(result, wrappedNext);
      } catch (e) {
        wrappedNext(e);
      }
    };

    // Preserve function name for debugging
    Object.defineProperty(wrappedErrorHandler, 'name', {
      value: 'cooperative_' + fnName,
      configurable: true
    });

    return wrappedErrorHandler;
  } else {
    // Regular middleware (3 params or less)
    var wrappedMiddleware = function cooperativeMiddleware(req, res, next) {
      var ctx = getContext(req);

      // If no context or request not active, call original
      if (!ctx || !isRequestActive(req, res)) {
        if (!isRequestActive(req, res)) {
          debug('request inactive, skipping middleware: %s', fnName);
          return;
        }
        return fn(req, res, next);
      }

      // Increment layer count
      ctx.burstLayerCount++;
      ctx.totalLayers++;

      debug('middleware: %s (layer %d)', fnName, ctx.totalLayers);

      // Wrap next to add yield checkpoint
      var wrappedNext = createWrappedNext(ctx, req, res, next, fnName);

      // Call original middleware
      try {
        var result = fn(req, res, wrappedNext);
        handlePromiseResult(result, wrappedNext);
      } catch (e) {
        wrappedNext(e);
      }
    };

    // Preserve function name
    Object.defineProperty(wrappedMiddleware, 'name', {
      value: 'cooperative_' + fnName,
      configurable: true
    });

    // Preserve arity for middleware detection
    // The router checks fn.length to distinguish middleware from error handlers
    if (fn.length <= 3) {
      return wrappedMiddleware;
    }

    return wrappedMiddleware;
  }
}

/**
 * Create a wrapped next function that adds yield checkpoints.
 *
 * @param {Object} ctx - Dispatch context
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Original next function
 * @param {string} fnName - Middleware function name for debugging
 * @return {Function} Wrapped next function
 * @private
 */

function createWrappedNext(ctx, req, res, next, fnName) {
  var called = false;

  return function wrappedNext(err) {
    // Guard against multiple calls
    if (called) {
      debug('next() called multiple times in %s, ignoring', fnName);
      return;
    }
    called = true;

    // Check if request is still active
    if (!isRequestActive(req, res)) {
      debug('request inactive after %s, stopping dispatch', fnName);
      return;
    }

    // Check if we should yield
    if (shouldYield(ctx)) {
      debug('yielding after %s', fnName);

      setImmediate(function resumeAfterYield() {
        // Check request state again after yield
        if (!isRequestActive(req, res)) {
          debug('request became inactive during yield after %s', fnName);
          return;
        }

        // Reset budget for next burst
        resetBurstBudget(ctx);

        // Continue dispatch
        next(err);
      });
    } else {
      // Continue synchronously
      next(err);
    }
  };
}

/**
 * Handle promise result from middleware (if it returns a promise).
 * Rejected promises should call next(err).
 *
 * @param {*} result - Return value from middleware
 * @param {Function} next - Next function to call on rejection
 * @private
 */

function handlePromiseResult(result, next) {
  if (result && typeof result.then === 'function') {
    result.then(null, function(err) {
      next(err || new Error('Rejected promise'));
    });
  }
}

/**
 * Export internal functions for testing.
 * @private
 */

module.exports._internal = {
  DISPATCH_CONTEXT: DISPATCH_CONTEXT,
  shouldYield: shouldYield,
  resetBurstBudget: resetBurstBudget,
  isRequestActive: isRequestActive,
  getContext: getContext,
  setContext: setContext,
  wrapMiddleware: wrapMiddleware,
  createWrappedNext: createWrappedNext
};
