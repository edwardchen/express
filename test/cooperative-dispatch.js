'use strict'

var assert = require('node:assert');
var express = require('..');
var request = require('supertest');

describe('cooperative dispatch', function () {
  describe('when disabled (default)', function () {
    it('should behave exactly as before', function (done) {
      var app = express();
      var order = [];

      app.use(function (req, res, next) {
        order.push(1);
        next();
      });

      app.use(function (req, res, next) {
        order.push(2);
        next();
      });

      app.get('/', function (req, res) {
        order.push(3);
        res.send('done');
      });

      request(app)
        .get('/')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2, 3]);
          done();
        });
    });

    it('should preserve next("route") behavior', function (done) {
      var app = express();
      var order = [];

      app.get('/', function (req, res, next) {
        order.push(1);
        next('route');
      }, function (req, res, next) {
        order.push('should not run');
        next();
      });

      app.get('/', function (req, res) {
        order.push(2);
        res.send('done');
      });

      request(app)
        .get('/')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2]);
          done();
        });
    });

    it('should preserve error handler behavior', function (done) {
      var app = express();
      var order = [];

      app.use(function (req, res, next) {
        order.push(1);
        next(new Error('test error'));
      });

      app.use(function (req, res, next) {
        order.push('should not run');
        next();
      });

      app.use(function (err, req, res, next) {
        order.push(2);
        res.status(500).send('error handled');
      });

      request(app)
        .get('/')
        .expect(500)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2]);
          done();
        });
    });
  });

  describe('when enabled', function () {
    it('should preserve middleware ordering', function (done) {
      var app = express();
      var order = [];

      // Enable cooperative dispatch
      app.set('cooperative dispatch', { layerBudget: 50, timeBudget: 2 });

      app.use(function (req, res, next) {
        order.push(1);
        next();
      });

      app.use(function (req, res, next) {
        order.push(2);
        next();
      });

      app.get('/', function (req, res) {
        order.push(3);
        res.send('done');
      });

      request(app)
        .get('/')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2, 3]);
          done();
        });
    });

    it('should preserve next("route") behavior', function (done) {
      var app = express();
      var order = [];

      app.set('cooperative dispatch', { layerBudget: 50 });

      app.get('/', function (req, res, next) {
        order.push(1);
        next('route');
      }, function (req, res, next) {
        order.push('should not run');
        next();
      });

      app.get('/', function (req, res) {
        order.push(2);
        res.send('done');
      });

      request(app)
        .get('/')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2]);
          done();
        });
    });

    it('should preserve next("router") behavior', function (done) {
      var app = express();
      var router = express.Router();
      var order = [];

      app.set('cooperative dispatch', { layerBudget: 50 });

      router.use(function (req, res, next) {
        order.push(1);
        next('router');
      });

      router.use(function (req, res, next) {
        order.push('should not run in router');
        next();
      });

      app.use('/test', router);

      app.use(function (req, res) {
        order.push(2);
        res.send('done');
      });

      request(app)
        .get('/test')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2]);
          done();
        });
    });

    it('should preserve error handler behavior', function (done) {
      var app = express();
      var order = [];

      app.set('cooperative dispatch', { layerBudget: 50 });

      app.use(function (req, res, next) {
        order.push(1);
        next(new Error('test error'));
      });

      app.use(function (req, res, next) {
        order.push('should not run');
        next();
      });

      app.use(function (err, req, res, next) {
        order.push(2);
        res.status(500).send('error handled');
      });

      request(app)
        .get('/')
        .expect(500)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2]);
          done();
        });
    });

    it('should work with nested routers', function (done) {
      var app = express();
      var router1 = express.Router();
      var router2 = express.Router();
      var order = [];

      app.set('cooperative dispatch', { layerBudget: 50 });

      router2.get('/deep', function (req, res) {
        order.push(3);
        res.send('deep');
      });

      router1.use(function (req, res, next) {
        order.push(2);
        next();
      });
      router1.use('/level2', router2);

      app.use(function (req, res, next) {
        order.push(1);
        next();
      });
      app.use('/level1', router1);

      request(app)
        .get('/level1/level2/deep')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2, 3]);
          done();
        });
    });

    it('should yield during long synchronous chains', function (done) {
      this.timeout(5000);

      var app = express();
      var counter = 0;

      // Use a very low layer budget to force yielding
      app.set('cooperative dispatch', { layerBudget: 10, timeBudget: 1 });

      // Add many synchronous middleware
      for (var i = 0; i < 100; i++) {
        app.use(function (req, res, next) {
          counter++;
          next();
        });
      }

      app.get('/', function (req, res) {
        res.json({ counter: counter });
      });

      request(app)
        .get('/')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.strictEqual(res.body.counter, 100);
          done();
        });
    });

    it('should handle error propagation through yielded dispatch', function (done) {
      var app = express();
      var order = [];

      app.set('cooperative dispatch', { layerBudget: 2 });

      // Add middleware to trigger yielding before error
      app.use(function (req, res, next) {
        order.push(1);
        next();
      });
      app.use(function (req, res, next) {
        order.push(2);
        next();
      });
      app.use(function (req, res, next) {
        order.push(3);
        next();
      });
      app.use(function (req, res, next) {
        order.push(4);
        next(new Error('delayed error'));
      });

      app.use(function (err, req, res, next) {
        order.push('error');
        res.status(500).send('caught');
      });

      request(app)
        .get('/')
        .expect(500)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2, 3, 4, 'error']);
          done();
        });
    });

    it('should work with async middleware', function (done) {
      var app = express();
      var order = [];

      app.set('cooperative dispatch', { layerBudget: 2 });

      app.use(function (req, res, next) {
        order.push(1);
        setTimeout(function () {
          order.push(2);
          next();
        }, 10);
      });

      app.use(function (req, res, next) {
        order.push(3);
        next();
      });

      app.get('/', function (req, res) {
        order.push(4);
        res.send('done');
      });

      request(app)
        .get('/')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2, 3, 4]);
          done();
        });
    });

    it('should handle multiple next() calls correctly', function (done) {
      var app = express();

      app.set('cooperative dispatch', { layerBudget: 50 });

      app.use(function (req, res, next) {
        next();
        // Second call should be ignored (standard Express behavior)
        next();
      });

      app.get('/', function (req, res) {
        if (!res.headersSent) {
          res.send('done');
        }
      });

      // Error handler
      app.use(function (err, req, res, next) {
        if (!res.headersSent) {
          res.status(500).send('error');
        }
      });

      request(app)
        .get('/')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          done();
        });
    });

    it('should handle mounted sub-apps', function (done) {
      var app = express();
      var subApp = express();
      var order = [];

      app.set('cooperative dispatch', { layerBudget: 50 });
      // Note: sub-app inherits cooperative dispatch setting

      subApp.use(function (req, res, next) {
        order.push(2);
        next();
      });

      subApp.get('/sub', function (req, res) {
        order.push(3);
        res.send('sub');
      });

      app.use(function (req, res, next) {
        order.push(1);
        next();
      });

      app.use('/mounted', subApp);

      request(app)
        .get('/mounted/sub')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.deepStrictEqual(order, [1, 2, 3]);
          done();
        });
    });

    it('should respect maxYields safety valve', function (done) {
      this.timeout(10000);

      var app = express();

      // Very aggressive yielding with low maxYields
      app.set('cooperative dispatch', {
        layerBudget: 1,
        timeBudget: 0,
        maxYields: 5
      });

      // Add many middleware
      for (var i = 0; i < 100; i++) {
        app.use(function (req, res, next) {
          next();
        });
      }

      app.get('/', function (req, res) {
        res.send('done');
      });

      request(app)
        .get('/')
        .expect(200)
        .end(done);
    });
  });

  describe('configuration', function () {
    it('should accept boolean true as shorthand for defaults', function (done) {
      var app = express();

      // Enable with defaults
      app.set('cooperative dispatch', true);

      app.get('/', function (req, res) {
        res.send('ok');
      });

      request(app)
        .get('/')
        .expect(200, 'ok', done);
    });

    it('should accept custom layerBudget', function (done) {
      var app = express();

      app.set('cooperative dispatch', { layerBudget: 100 });

      app.get('/', function (req, res) {
        res.send('ok');
      });

      request(app)
        .get('/')
        .expect(200, 'ok', done);
    });

    it('should accept custom timeBudget', function (done) {
      var app = express();

      app.set('cooperative dispatch', { timeBudget: 10 });

      app.get('/', function (req, res) {
        res.send('ok');
      });

      request(app)
        .get('/')
        .expect(200, 'ok', done);
    });
  });

  describe('route parameters', function () {
    it('should work with route params and cooperative dispatch', function (done) {
      var app = express();
      var params = {};

      app.set('cooperative dispatch', { layerBudget: 50 });

      app.param('id', function (req, res, next, id) {
        params.id = id;
        next();
      });

      app.get('/users/:id', function (req, res) {
        res.json({ id: req.params.id, paramId: params.id });
      });

      request(app)
        .get('/users/42')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.strictEqual(res.body.id, '42');
          assert.strictEqual(res.body.paramId, '42');
          done();
        });
    });
  });

  describe('stress test', function () {
    it('should handle large middleware stack without stack overflow', function (done) {
      this.timeout(10000);

      var app = express();
      var counter = { value: 0 };

      app.set('cooperative dispatch', { layerBudget: 20, timeBudget: 1 });

      app.use(function (req, res, next) {
        counter.value = 0;
        next();
      });

      // Add 5000 middleware - this would overflow stack without cooperative dispatch
      for (var i = 0; i < 5000; i++) {
        app.use(function (req, res, next) {
          counter.value++;
          next();
        });
      }

      app.get('/', function (req, res) {
        res.json({ count: counter.value });
      });

      request(app)
        .get('/')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          assert.strictEqual(res.body.count, 5000);
          done();
        });
    });
  });
});
