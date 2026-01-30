'use strict'

var after = require('after');
var assert = require('node:assert');
var express = require('../');
var request = require('supertest');

describe('cooperative dispatch', function () {
  describe('when disabled (default)', function () {
    it('should behave identically to normal dispatch', function (done) {
      var app = express();
      var order = [];

      app.use(function (req, res, next) {
        order.push('mw1');
        next();
      });

      app.use(function (req, res, next) {
        order.push('mw2');
        next();
      });

      app.get('/foo', function (req, res) {
        order.push('route');
        res.json(order);
      });

      request(app)
        .get('/foo')
        .expect(200, ['mw1', 'mw2', 'route'], done);
    });

    it('should handle errors normally', function (done) {
      var app = express();

      app.get('/foo', function (req, res, next) {
        next(new Error('test error'));
      });

      app.use(function (err, req, res, next) {
        res.status(500).json({ error: err.message });
      });

      request(app)
        .get('/foo')
        .expect(500, { error: 'test error' }, done);
    });
  });

  describe('when enabled', function () {
    it('should preserve middleware ordering', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      var order = [];

      app.use(function (req, res, next) {
        order.push('mw1');
        next();
      });

      app.use(function (req, res, next) {
        order.push('mw2');
        next();
      });

      app.use(function (req, res, next) {
        order.push('mw3');
        next();
      });

      app.get('/foo', function (req, res) {
        order.push('route');
        res.json(order);
      });

      request(app)
        .get('/foo')
        .expect(200, ['mw1', 'mw2', 'mw3', 'route'], done);
    });

    it('should handle errors correctly', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      app.get('/foo', function (req, res, next) {
        next(new Error('test error'));
      });

      app.use(function (req, res, next) {
        // This should be skipped in error mode
        res.send('should not see this');
      });

      app.use(function (err, req, res, next) {
        res.status(500).json({ error: err.message });
      });

      request(app)
        .get('/foo')
        .expect(500, { error: 'test error' }, done);
    });

    it('should handle next("route") correctly', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      app.get('/foo',
        function (req, res, next) {
          next('route');
        },
        function (req, res) {
          res.send('should not see this');
        }
      );

      app.get('/foo', function (req, res) {
        res.send('correct route');
      });

      request(app)
        .get('/foo')
        .expect(200, 'correct route', done);
    });

    it('should handle next("router") correctly', function (done) {
      var app = express();
      var router = express.Router();
      app.enable('cooperative dispatch');

      router.get('/foo',
        function (req, res, next) {
          next('router');
        },
        function (req, res) {
          res.send('should not see this');
        }
      );

      app.use(router);

      app.get('/foo', function (req, res) {
        res.send('parent handler');
      });

      request(app)
        .get('/foo')
        .expect(200, 'parent handler', done);
    });

    it('should handle nested routers', function (done) {
      var app = express();
      var router1 = express.Router();
      var router2 = express.Router();
      app.enable('cooperative dispatch');

      var order = [];

      router2.use(function (req, res, next) {
        order.push('router2-mw');
        next();
      });

      router2.get('/baz', function (req, res) {
        order.push('router2-route');
        res.json(order);
      });

      router1.use(function (req, res, next) {
        order.push('router1-mw');
        next();
      });

      router1.use('/bar', router2);

      app.use(function (req, res, next) {
        order.push('app-mw');
        next();
      });

      app.use('/foo', router1);

      request(app)
        .get('/foo/bar/baz')
        .expect(200, ['app-mw', 'router1-mw', 'router2-mw', 'router2-route'], done);
    });

    it('should handle mounted apps', function (done) {
      var app = express();
      var subApp = express();
      app.enable('cooperative dispatch');

      var order = [];

      subApp.use(function (req, res, next) {
        order.push('subapp-mw');
        next();
      });

      subApp.get('/bar', function (req, res) {
        order.push('subapp-route');
        res.json(order);
      });

      app.use(function (req, res, next) {
        order.push('app-mw');
        next();
      });

      app.use('/foo', subApp);

      request(app)
        .get('/foo/bar')
        .expect(200, ['app-mw', 'subapp-mw', 'subapp-route'], done);
    });

    it('should handle async middleware', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      var order = [];

      app.use(async function (req, res, next) {
        await Promise.resolve();
        order.push('async-mw1');
        next();
      });

      app.use(function (req, res, next) {
        order.push('sync-mw');
        next();
      });

      app.use(async function (req, res, next) {
        await Promise.resolve();
        order.push('async-mw2');
        next();
      });

      app.get('/foo', function (req, res) {
        order.push('route');
        res.json(order);
      });

      request(app)
        .get('/foo')
        .expect(200, ['async-mw1', 'sync-mw', 'async-mw2', 'route'], done);
    });

    it('should handle async error throwing', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      app.get('/foo', async function (req, res, next) {
        await Promise.resolve();
        throw new Error('async error');
      });

      app.use(function (err, req, res, next) {
        res.status(500).json({ error: err.message });
      });

      request(app)
        .get('/foo')
        .expect(500, { error: 'async error' }, done);
    });

    it('should handle promise rejection', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      app.get('/foo', function (req, res, next) {
        return Promise.reject(new Error('promise rejection'));
      });

      app.use(function (err, req, res, next) {
        res.status(500).json({ error: err.message });
      });

      request(app)
        .get('/foo')
        .expect(500, { error: 'promise rejection' }, done);
    });

    it('should handle param handlers', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      var order = [];

      app.param('id', function (req, res, next, id) {
        order.push('param:' + id);
        req.userId = id;
        next();
      });

      app.get('/user/:id', function (req, res) {
        order.push('route:' + req.userId);
        res.json(order);
      });

      request(app)
        .get('/user/123')
        .expect(200, ['param:123', 'route:123'], done);
    });

    it('should handle multiple next() calls gracefully', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      var callCount = 0;

      app.use(function (req, res, next) {
        next();
        next(); // Second call should be ignored
        next(); // Third call should be ignored
      });

      app.use(function (req, res, next) {
        callCount++;
        next();
      });

      app.get('/foo', function (req, res) {
        res.json({ callCount: callCount });
      });

      request(app)
        .get('/foo')
        .expect(200, { callCount: 1 }, done);
    });

    it('should handle error handler chains', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      var order = [];

      app.get('/foo', function (req, res, next) {
        next(new Error('original error'));
      });

      app.use(function (err, req, res, next) {
        order.push('error-handler-1');
        next(new Error('modified error'));
      });

      app.use(function (err, req, res, next) {
        order.push('error-handler-2');
        res.status(500).json({ order: order, error: err.message });
      });

      request(app)
        .get('/foo')
        .expect(500) // error handler sets 500
        .expect(function (res) {
          assert.deepStrictEqual(res.body.order, ['error-handler-1', 'error-handler-2']);
          assert.strictEqual(res.body.error, 'modified error');
        })
        .end(done);
    });

    it('should handle app.all()', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      var order = [];

      app.all('/foo', function (req, res, next) {
        order.push('all-handler');
        next();
      });

      app.get('/foo', function (req, res) {
        order.push('get-handler');
        res.json(order);
      });

      request(app)
        .get('/foo')
        .expect(200, ['all-handler', 'get-handler'], done);
    });

    it('should handle thrown errors in sync middleware', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      app.get('/foo', function (req, res, next) {
        throw new Error('sync throw');
      });

      app.use(function (err, req, res, next) {
        res.status(500).json({ error: err.message });
      });

      request(app)
        .get('/foo')
        .expect(500, { error: 'sync throw' }, done);
    });
  });

  describe('yielding behavior', function () {
    it('should yield after exceeding layer budget', function (done) {
      var app = express();
      app.enable('cooperative dispatch');
      app.set('cooperative dispatch budget', { maxLayers: 3, maxTimeMs: 1000 });

      var yielded = false;
      var originalSetImmediate = global.setImmediate;

      // Track setImmediate calls
      global.setImmediate = function (fn) {
        yielded = true;
        return originalSetImmediate.call(global, fn);
      };

      // Add enough middleware to exceed the budget
      for (var i = 0; i < 10; i++) {
        app.use(function (req, res, next) {
          next();
        });
      }

      app.get('/foo', function (req, res) {
        global.setImmediate = originalSetImmediate;
        res.json({ yielded: yielded });
      });

      request(app)
        .get('/foo')
        .expect(200)
        .expect(function (res) {
          assert.strictEqual(res.body.yielded, true, 'Should have yielded');
        })
        .end(done);
    });

    it('should not yield if budget is not exceeded', function (done) {
      var app = express();
      app.enable('cooperative dispatch');
      app.set('cooperative dispatch budget', { maxLayers: 100, maxTimeMs: 1000 });

      var yieldCount = 0;
      var originalSetImmediate = global.setImmediate;

      // Track cooperative dispatch yields (not all setImmediate calls)
      global.setImmediate = function (fn) {
        if (fn.name === 'resumeAfterYield') {
          yieldCount++;
        }
        return originalSetImmediate.call(global, fn);
      };

      // Add a few middleware (less than budget)
      for (var i = 0; i < 3; i++) {
        app.use(function (req, res, next) {
          next();
        });
      }

      app.get('/foo', function (req, res) {
        global.setImmediate = originalSetImmediate;
        res.json({ yieldCount: yieldCount });
      });

      request(app)
        .get('/foo')
        .expect(200)
        .expect(function (res) {
          assert.strictEqual(res.body.yieldCount, 0, 'Should not have yielded');
        })
        .end(done);
    });

    it('should respect maxTotalYields safety valve', function (done) {
      var app = express();
      app.enable('cooperative dispatch');
      // Very aggressive budget to force many yields, but limit total
      app.set('cooperative dispatch budget', {
        maxLayers: 1,
        maxTimeMs: 0,
        maxTotalYields: 3
      });

      var yieldCount = 0;
      var originalSetImmediate = global.setImmediate;

      global.setImmediate = function (fn) {
        if (fn.name === 'resumeAfterYield') {
          yieldCount++;
        }
        return originalSetImmediate.call(global, fn);
      };

      // Add many middleware
      for (var i = 0; i < 20; i++) {
        app.use(function (req, res, next) {
          next();
        });
      }

      app.get('/foo', function (req, res) {
        global.setImmediate = originalSetImmediate;
        res.json({ yieldCount: yieldCount });
      });

      request(app)
        .get('/foo')
        .expect(200)
        .expect(function (res) {
          // Should be capped at maxTotalYields
          assert.ok(res.body.yieldCount <= 3, 'Yield count should be <= 3');
        })
        .end(done);
    });

    it('should handle long middleware chains without stack overflow', function (done) {
      this.timeout(10000);

      var app = express();
      app.enable('cooperative dispatch');
      app.set('cooperative dispatch budget', { maxLayers: 100, maxTimeMs: 5 });

      var count = 0;

      // Add many middleware - this would overflow the stack without yielding
      for (var i = 0; i < 1000; i++) {
        app.use(function (req, res, next) {
          count++;
          next();
        });
      }

      app.get('/foo', function (req, res) {
        res.json({ count: count });
      });

      request(app)
        .get('/foo')
        .expect(200)
        .expect(function (res) {
          assert.strictEqual(res.body.count, 1000);
        })
        .end(done);
    });
  });

  describe('parallel requests', function () {
    it('should not mix request state between parallel requests', function (done) {
      var app = express();
      app.enable('cooperative dispatch');
      app.set('cooperative dispatch budget', { maxLayers: 2, maxTimeMs: 1000 });

      app.use(function (req, res, next) {
        req.myValue = req.query.value;
        next();
      });

      app.use(function (req, res, next) {
        // Simulate async work
        setTimeout(function () {
          next();
        }, parseInt(req.query.delay) || 0);
      });

      app.get('/foo', function (req, res) {
        res.json({ value: req.myValue });
      });

      var cb = after(3, done);

      // Send parallel requests with different values
      request(app)
        .get('/foo?value=A&delay=50')
        .expect(200, { value: 'A' }, cb);

      request(app)
        .get('/foo?value=B&delay=10')
        .expect(200, { value: 'B' }, cb);

      request(app)
        .get('/foo?value=C&delay=30')
        .expect(200, { value: 'C' }, cb);
    });
  });

  describe('abort/close handling', function () {
    it('should stop dispatch when response is ended', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      var afterEndCalled = false;

      app.use(function (req, res, next) {
        res.send('done');
        next();
      });

      app.use(function (req, res, next) {
        afterEndCalled = true;
        next();
      });

      request(app)
        .get('/foo')
        .expect(200, 'done')
        .end(function (err) {
          if (err) return done(err);
          // Give time for the next middleware to potentially run
          setTimeout(function () {
            assert.strictEqual(afterEndCalled, false, 'Middleware after res.send should not run');
            done();
          }, 50);
        });
    });
  });

  describe('budget configuration', function () {
    it('should use default budget when not configured', function (done) {
      var app = express();
      app.enable('cooperative dispatch');

      // Just verify it works with defaults
      app.get('/foo', function (req, res) {
        res.send('ok');
      });

      request(app)
        .get('/foo')
        .expect(200, 'ok', done);
    });

    it('should use custom budget configuration', function (done) {
      var app = express();
      app.enable('cooperative dispatch');
      app.set('cooperative dispatch budget', {
        maxTimeMs: 10,
        maxLayers: 5,
        maxTotalYields: 50
      });

      app.get('/foo', function (req, res) {
        res.send('ok');
      });

      request(app)
        .get('/foo')
        .expect(200, 'ok', done);
    });
  });
});

describe('cooperative-dispatch module', function () {
  var cooperativeDispatch = require('../lib/cooperative-dispatch');

  describe('createDispatchContext', function () {
    it('should create context with default values', function () {
      var ctx = cooperativeDispatch.createDispatchContext();

      assert.strictEqual(ctx.maxTimeMs, 2);
      assert.strictEqual(ctx.maxLayers, 50);
      assert.strictEqual(ctx.maxTotalYields, 100);
      assert.strictEqual(ctx.burstLayerCount, 0);
      assert.strictEqual(ctx.totalYields, 0);
      assert.strictEqual(ctx.totalLayers, 0);
    });

    it('should create context with custom values', function () {
      var ctx = cooperativeDispatch.createDispatchContext({
        maxTimeMs: 5,
        maxLayers: 100,
        maxTotalYields: 50
      });

      assert.strictEqual(ctx.maxTimeMs, 5);
      assert.strictEqual(ctx.maxLayers, 100);
      assert.strictEqual(ctx.maxTotalYields, 50);
    });

    it('should handle partial configuration', function () {
      var ctx = cooperativeDispatch.createDispatchContext({
        maxTimeMs: 10
      });

      assert.strictEqual(ctx.maxTimeMs, 10);
      assert.strictEqual(ctx.maxLayers, 50); // default
      assert.strictEqual(ctx.maxTotalYields, 100); // default
    });
  });

  describe('_internal.shouldYield', function () {
    it('should return false when budget is not exhausted', function () {
      var ctx = cooperativeDispatch.createDispatchContext({
        maxTimeMs: 1000,
        maxLayers: 100
      });

      ctx.burstLayerCount = 5;

      assert.strictEqual(cooperativeDispatch._internal.shouldYield(ctx), false);
    });

    it('should return true when layer budget is exhausted', function () {
      var ctx = cooperativeDispatch.createDispatchContext({
        maxTimeMs: 1000,
        maxLayers: 10
      });

      ctx.burstLayerCount = 15;

      assert.strictEqual(cooperativeDispatch._internal.shouldYield(ctx), true);
    });

    it('should return false when max yields reached', function () {
      var ctx = cooperativeDispatch.createDispatchContext({
        maxTimeMs: 0,
        maxLayers: 1,
        maxTotalYields: 5
      });

      ctx.burstLayerCount = 100;
      ctx.totalYields = 5;

      assert.strictEqual(cooperativeDispatch._internal.shouldYield(ctx), false);
    });
  });

  describe('_internal.resetBurstBudget', function () {
    it('should reset burst state and increment yield counter', function () {
      var ctx = cooperativeDispatch.createDispatchContext();

      ctx.burstLayerCount = 50;
      ctx.totalYields = 2;

      cooperativeDispatch._internal.resetBurstBudget(ctx);

      assert.strictEqual(ctx.burstLayerCount, 0);
      assert.strictEqual(ctx.totalYields, 3);
      assert.strictEqual(ctx.yieldScheduled, false);
    });
  });

  describe('_internal.isRequestActive', function () {
    it('should return true for active request', function () {
      var req = { destroyed: false };
      var res = { writableEnded: false, finished: false };

      assert.strictEqual(cooperativeDispatch._internal.isRequestActive(req, res), true);
    });

    it('should return false for destroyed request', function () {
      var req = { destroyed: true };
      var res = { writableEnded: false, finished: false };

      assert.strictEqual(cooperativeDispatch._internal.isRequestActive(req, res), false);
    });

    it('should return false when response ended', function () {
      var req = { destroyed: false };
      var res = { writableEnded: true, finished: false };

      assert.strictEqual(cooperativeDispatch._internal.isRequestActive(req, res), false);
    });

    it('should return false when response finished', function () {
      var req = { destroyed: false };
      var res = { writableEnded: false, finished: true };

      assert.strictEqual(cooperativeDispatch._internal.isRequestActive(req, res), false);
    });

    it('should return false when socket destroyed', function () {
      var req = { destroyed: false, socket: { destroyed: true } };
      var res = { writableEnded: false, finished: false };

      assert.strictEqual(cooperativeDispatch._internal.isRequestActive(req, res), false);
    });
  });

  describe('DEFAULT_BUDGET', function () {
    it('should be frozen', function () {
      assert.strictEqual(Object.isFrozen(cooperativeDispatch.DEFAULT_BUDGET), true);
    });

    it('should have expected default values', function () {
      assert.strictEqual(cooperativeDispatch.DEFAULT_BUDGET.maxTimeMs, 2);
      assert.strictEqual(cooperativeDispatch.DEFAULT_BUDGET.maxLayers, 50);
      assert.strictEqual(cooperativeDispatch.DEFAULT_BUDGET.maxTotalYields, 100);
    });
  });
});
