#!/usr/bin/env node

/**
 * Cooperative Dispatch Benchmark
 *
 * This benchmark compares baseline Express performance against cooperative
 * dispatch mode, measuring p50/p99 latency, event loop lag, and throughput.
 *
 * Usage:
 *   node benchmarks/cooperative-dispatch-benchmark.js [options]
 *
 * Options:
 *   --middleware=N     Number of middleware layers (default: 100)
 *   --concurrency=N    Number of concurrent requests (default: 50)
 *   --requests=N       Total number of requests (default: 1000)
 *   --port=N           Server port (default: 3000)
 *   --mode=MODE        'baseline', 'cooperative', or 'both' (default: 'both')
 *   --heavy            Add CPU-intensive work in middleware
 */

'use strict';

const http = require('node:http');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const express = require('../');

// Parse command line arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace('--', '').split('=');
  acc[key] = value || true;
  return acc;
}, {});

const config = {
  middlewareCount: parseInt(args.middleware) || 100,
  concurrency: parseInt(args.concurrency) || 50,
  totalRequests: parseInt(args.requests) || 1000,
  port: parseInt(args.port) || 3000,
  mode: args.mode || 'both',
  heavy: args.heavy || false,
  budgetMaxLayers: parseInt(args.budgetLayers) || 20,
  budgetMaxTimeMs: parseInt(args.budgetTime) || 2
};

/**
 * Create an Express app with the specified configuration
 */
function createApp(cooperative) {
  const app = express();

  if (cooperative) {
    app.enable('cooperative dispatch');
    app.set('cooperative dispatch budget', {
      maxLayers: config.budgetMaxLayers,
      maxTimeMs: config.budgetMaxTimeMs,
      maxTotalYields: 100
    });
  }

  // Initialize middleware counter on request
  app.use(function init(req, res, next) {
    req.middlewareCount = 0;
    req.startTime = process.hrtime.bigint();
    next();
  });

  // Add N middleware layers
  for (let i = 0; i < config.middlewareCount; i++) {
    if (config.heavy) {
      // CPU-intensive middleware (simulates real workload)
      app.use(function heavyMiddleware(req, res, next) {
        req.middlewareCount++;
        // Simulate CPU work (small computation)
        let sum = 0;
        for (let j = 0; j < 1000; j++) {
          sum += Math.sqrt(j);
        }
        req.computeResult = sum;
        next();
      });
    } else {
      // Lightweight middleware
      app.use(function lightMiddleware(req, res, next) {
        req.middlewareCount++;
        next();
      });
    }
  }

  // Final handler
  app.get('/test', function handler(req, res) {
    const endTime = process.hrtime.bigint();
    const durationNs = Number(endTime - req.startTime);
    res.json({
      middlewareCount: req.middlewareCount,
      durationMs: durationNs / 1e6
    });
  });

  // 404 handler
  app.use(function notFound(req, res) {
    res.status(404).send('Not Found');
  });

  return app;
}

/**
 * Calculate percentiles from an array of numbers
 */
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Calculate statistics from latency array
 */
function calculateStats(latencies) {
  if (latencies.length === 0) {
    return { p50: 0, p90: 0, p99: 0, p999: 0, min: 0, max: 0, avg: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    p999: percentile(sorted, 99.9),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length
  };
}

/**
 * Make a single HTTP request
 */
function makeRequest(port) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();

    const req = http.request({
      hostname: 'localhost',
      port: port,
      path: '/test',
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const end = process.hrtime.bigint();
        const latencyMs = Number(end - start) / 1e6;
        resolve({
          latency: latencyMs,
          status: res.statusCode,
          body: data
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

/**
 * Run benchmark with specified concurrency
 */
async function runBenchmark(port, totalRequests, concurrency) {
  const latencies = [];
  const errors = [];
  let completed = 0;

  // Create event loop lag monitor
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const startTime = process.hrtime.bigint();

  // Process requests in batches of concurrency
  for (let i = 0; i < totalRequests; i += concurrency) {
    const batchSize = Math.min(concurrency, totalRequests - i);
    const batch = [];

    for (let j = 0; j < batchSize; j++) {
      batch.push(
        makeRequest(port)
          .then(result => {
            latencies.push(result.latency);
            completed++;
          })
          .catch(err => {
            errors.push(err.message);
            completed++;
          })
      );
    }

    await Promise.all(batch);

    // Progress indicator
    if (completed % 100 === 0) {
      process.stdout.write(`\r  Progress: ${completed}/${totalRequests}`);
    }
  }

  const endTime = process.hrtime.bigint();
  const totalTimeMs = Number(endTime - startTime) / 1e6;

  histogram.disable();

  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  return {
    latencyStats: calculateStats(latencies),
    eventLoopLag: {
      min: histogram.min / 1e6,
      max: histogram.max / 1e6,
      mean: histogram.mean / 1e6,
      p50: histogram.percentile(50) / 1e6,
      p99: histogram.percentile(99) / 1e6
    },
    throughput: {
      requestsPerSecond: (latencies.length / totalTimeMs) * 1000,
      totalTimeMs: totalTimeMs
    },
    errors: errors.length,
    successful: latencies.length
  };
}

/**
 * Format results as a table
 */
function formatResults(name, results) {
  console.log(`\n${name}:`);
  console.log('─'.repeat(50));

  console.log('\nLatency (ms):');
  console.log(`  p50:  ${results.latencyStats.p50.toFixed(2)}`);
  console.log(`  p90:  ${results.latencyStats.p90.toFixed(2)}`);
  console.log(`  p99:  ${results.latencyStats.p99.toFixed(2)}`);
  console.log(`  p99.9: ${results.latencyStats.p999.toFixed(2)}`);
  console.log(`  min:  ${results.latencyStats.min.toFixed(2)}`);
  console.log(`  max:  ${results.latencyStats.max.toFixed(2)}`);
  console.log(`  avg:  ${results.latencyStats.avg.toFixed(2)}`);

  console.log('\nEvent Loop Lag (ms):');
  console.log(`  min:  ${results.eventLoopLag.min.toFixed(2)}`);
  console.log(`  max:  ${results.eventLoopLag.max.toFixed(2)}`);
  console.log(`  mean: ${results.eventLoopLag.mean.toFixed(2)}`);
  console.log(`  p50:  ${results.eventLoopLag.p50.toFixed(2)}`);
  console.log(`  p99:  ${results.eventLoopLag.p99.toFixed(2)}`);

  console.log('\nThroughput:');
  console.log(`  req/s: ${results.throughput.requestsPerSecond.toFixed(2)}`);
  console.log(`  total: ${results.throughput.totalTimeMs.toFixed(2)}ms`);

  console.log(`\nSuccessful: ${results.successful}, Errors: ${results.errors}`);
}

/**
 * Compare two result sets
 */
function compareResults(baseline, cooperative) {
  console.log('\n' + '═'.repeat(50));
  console.log('COMPARISON (cooperative vs baseline):');
  console.log('═'.repeat(50));

  const p50Delta = ((cooperative.latencyStats.p50 - baseline.latencyStats.p50) / baseline.latencyStats.p50 * 100);
  const p99Delta = ((cooperative.latencyStats.p99 - baseline.latencyStats.p99) / baseline.latencyStats.p99 * 100);
  const throughputDelta = ((cooperative.throughput.requestsPerSecond - baseline.throughput.requestsPerSecond) / baseline.throughput.requestsPerSecond * 100);
  const lagP99Delta = ((cooperative.eventLoopLag.p99 - baseline.eventLoopLag.p99) / baseline.eventLoopLag.p99 * 100);

  console.log('\nLatency Change:');
  console.log(`  p50: ${p50Delta > 0 ? '+' : ''}${p50Delta.toFixed(1)}%`);
  console.log(`  p99: ${p99Delta > 0 ? '+' : ''}${p99Delta.toFixed(1)}%`);

  console.log('\nEvent Loop Lag p99 Change:');
  console.log(`  ${lagP99Delta > 0 ? '+' : ''}${lagP99Delta.toFixed(1)}%`);

  console.log('\nThroughput Change:');
  console.log(`  ${throughputDelta > 0 ? '+' : ''}${throughputDelta.toFixed(1)}%`);

  // Interpretation
  console.log('\n' + '─'.repeat(50));
  console.log('INTERPRETATION:');

  if (p99Delta < 0) {
    console.log(`  ✓ p99 latency IMPROVED by ${Math.abs(p99Delta).toFixed(1)}%`);
  } else {
    console.log(`  ✗ p99 latency regressed by ${p99Delta.toFixed(1)}%`);
  }

  if (p50Delta > 0) {
    console.log(`  • p50 latency regressed by ${p50Delta.toFixed(1)}% (expected tradeoff)`);
  } else {
    console.log(`  ✓ p50 latency IMPROVED by ${Math.abs(p50Delta).toFixed(1)}%`);
  }

  if (lagP99Delta < 0) {
    console.log(`  ✓ Event loop lag REDUCED by ${Math.abs(lagP99Delta).toFixed(1)}%`);
  }
}

/**
 * Main benchmark runner
 */
async function main() {
  console.log('═'.repeat(50));
  console.log('Cooperative Dispatch Benchmark');
  console.log('═'.repeat(50));
  console.log(`\nConfiguration:`);
  console.log(`  Middleware layers: ${config.middlewareCount}`);
  console.log(`  Concurrency: ${config.concurrency}`);
  console.log(`  Total requests: ${config.totalRequests}`);
  console.log(`  Heavy middleware: ${config.heavy}`);
  console.log(`  Budget (layers): ${config.budgetMaxLayers}`);
  console.log(`  Budget (time ms): ${config.budgetMaxTimeMs}`);
  console.log(`  Mode: ${config.mode}`);

  let baselineResults = null;
  let cooperativeResults = null;

  // Run baseline benchmark
  if (config.mode === 'baseline' || config.mode === 'both') {
    console.log('\n' + '─'.repeat(50));
    console.log('Running BASELINE benchmark...');

    const baselineApp = createApp(false);
    const baselineServer = baselineApp.listen(config.port);

    // Warmup
    console.log('  Warming up...');
    await runBenchmark(config.port, 100, 10);

    // Actual benchmark
    console.log('  Running benchmark...');
    baselineResults = await runBenchmark(config.port, config.totalRequests, config.concurrency);

    baselineServer.close();
    formatResults('BASELINE', baselineResults);
  }

  // Run cooperative benchmark
  if (config.mode === 'cooperative' || config.mode === 'both') {
    console.log('\n' + '─'.repeat(50));
    console.log('Running COOPERATIVE DISPATCH benchmark...');

    const cooperativeApp = createApp(true);
    const cooperativeServer = cooperativeApp.listen(config.port);

    // Warmup
    console.log('  Warming up...');
    await runBenchmark(config.port, 100, 10);

    // Actual benchmark
    console.log('  Running benchmark...');
    cooperativeResults = await runBenchmark(config.port, config.totalRequests, config.concurrency);

    cooperativeServer.close();
    formatResults('COOPERATIVE DISPATCH', cooperativeResults);
  }

  // Compare if both were run
  if (baselineResults && cooperativeResults) {
    compareResults(baselineResults, cooperativeResults);
  }

  console.log('\n' + '═'.repeat(50));
  console.log('Benchmark complete.');
}

// Run the benchmark
main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
