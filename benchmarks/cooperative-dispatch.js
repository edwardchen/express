#!/usr/bin/env node
/**
 * Cooperative Dispatch Benchmark
 *
 * This benchmark demonstrates the p50/p99 latency tradeoff when using
 * cooperative dispatch mode in Express.
 *
 * Usage:
 *   node benchmarks/cooperative-dispatch.js
 *
 * The benchmark:
 * 1. Creates an Express app with many synchronous middleware
 * 2. Runs concurrent requests in baseline mode (cooperative dispatch off)
 * 3. Runs concurrent requests with cooperative dispatch enabled
 * 4. Compares p50, p99, and event loop lag
 */

'use strict'

const http = require('node:http')
const express = require('..')

// Configuration
const MIDDLEWARE_COUNT = 200  // Number of sync middleware per request
const CONCURRENT_REQUESTS = 50
const TOTAL_REQUESTS = 500
const HEAVY_WORK_ITERATIONS = 1000  // CPU work per middleware

// Track event loop lag
function monitorEventLoopLag() {
  const samples = []
  let lastCheck = process.hrtime.bigint()

  const interval = setInterval(() => {
    const now = process.hrtime.bigint()
    const expected = 1000000n  // 1ms in nanoseconds
    const actual = now - lastCheck
    const lag = Number(actual - expected) / 1000000  // Convert to ms
    if (lag > 0) {
      samples.push(lag)
    }
    lastCheck = now
  }, 1)

  return {
    stop: () => {
      clearInterval(interval)
      return samples
    }
  }
}

// Calculate percentiles
function percentile(arr, p) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

function mean(arr) {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

// Create test app
function createApp(cooperativeDispatch) {
  const app = express()

  if (cooperativeDispatch) {
    app.set('cooperative dispatch', {
      layerBudget: 20,
      timeBudget: 1
    })
  }

  // Add many synchronous middleware that do CPU work
  for (let i = 0; i < MIDDLEWARE_COUNT; i++) {
    app.use((req, res, next) => {
      // Simulate CPU-bound work
      let sum = 0
      for (let j = 0; j < HEAVY_WORK_ITERATIONS; j++) {
        sum += Math.sqrt(j) * Math.sin(j)
      }
      req._sum = (req._sum || 0) + sum
      next()
    })
  }

  app.get('/', (req, res) => {
    res.json({ ok: true, middlewareRun: MIDDLEWARE_COUNT })
  })

  return app
}

// Make HTTP request and measure latency
function makeRequest(port) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint()

    const req = http.request({
      hostname: 'localhost',
      port: port,
      path: '/',
      method: 'GET'
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        const end = process.hrtime.bigint()
        const latencyMs = Number(end - start) / 1000000
        resolve(latencyMs)
      })
    })

    req.on('error', reject)
    req.end()
  })
}

// Run concurrent requests
async function runConcurrentRequests(port, total, concurrency) {
  const latencies = []
  let completed = 0
  let errors = 0
  let inflight = 0

  return new Promise((resolve, reject) => {
    function launch() {
      while (inflight < concurrency && completed + errors + inflight < total) {
        inflight++
        makeRequest(port)
          .then(latency => {
            latencies.push(latency)
            inflight--
            completed++
            if (completed + errors === total) {
              resolve(latencies)
            } else {
              launch()
            }
          })
          .catch(err => {
            // Tolerate some connection errors under high load
            inflight--
            errors++
            if (errors > total * 0.1) {
              reject(new Error(`Too many errors: ${errors}`))
            } else if (completed + errors === total) {
              resolve(latencies)
            } else {
              launch()
            }
          })
      }
    }
    launch()
  })
}

// Run benchmark for a mode
async function runBenchmark(name, cooperativeDispatch, port) {
  console.log(`\n=== ${name} ===`)

  const app = createApp(cooperativeDispatch)
  const server = http.createServer(app)

  await new Promise(resolve => server.listen(port, resolve))
  console.log(`Server listening on port ${port}`)

  // Warm up
  console.log('Warming up...')
  await runConcurrentRequests(port, 50, 10)

  // Small delay after warmup
  await new Promise(r => setTimeout(r, 100))

  // Start monitoring
  const lagMonitor = monitorEventLoopLag()

  // Run benchmark
  console.log(`Running ${TOTAL_REQUESTS} requests with ${CONCURRENT_REQUESTS} concurrency...`)
  const start = process.hrtime.bigint()
  const latencies = await runConcurrentRequests(port, TOTAL_REQUESTS, CONCURRENT_REQUESTS)
  const end = process.hrtime.bigint()

  const lagSamples = lagMonitor.stop()

  // Close server and wait
  await new Promise(resolve => server.close(resolve))
  await new Promise(r => setTimeout(r, 100))

  // Calculate metrics
  const totalTimeMs = Number(end - start) / 1000000
  const results = {
    mode: name,
    cooperativeDispatch,
    config: {
      middlewareCount: MIDDLEWARE_COUNT,
      heavyWorkIterations: HEAVY_WORK_ITERATIONS,
      concurrentRequests: CONCURRENT_REQUESTS,
      totalRequests: TOTAL_REQUESTS
    },
    latency: {
      mean: mean(latencies).toFixed(2),
      p50: percentile(latencies, 50).toFixed(2),
      p75: percentile(latencies, 75).toFixed(2),
      p90: percentile(latencies, 90).toFixed(2),
      p95: percentile(latencies, 95).toFixed(2),
      p99: percentile(latencies, 99).toFixed(2),
      max: Math.max(...latencies).toFixed(2)
    },
    eventLoopLag: {
      samples: lagSamples.length,
      mean: mean(lagSamples).toFixed(2),
      p50: percentile(lagSamples, 50).toFixed(2),
      p99: percentile(lagSamples, 99).toFixed(2),
      max: lagSamples.length > 0 ? Math.max(...lagSamples).toFixed(2) : '0.00'
    },
    throughput: {
      totalTimeMs: totalTimeMs.toFixed(2),
      requestsPerSecond: ((TOTAL_REQUESTS / totalTimeMs) * 1000).toFixed(2)
    }
  }

  console.log('\nLatency (ms):')
  console.log(`  Mean: ${results.latency.mean}`)
  console.log(`  p50:  ${results.latency.p50}`)
  console.log(`  p75:  ${results.latency.p75}`)
  console.log(`  p90:  ${results.latency.p90}`)
  console.log(`  p95:  ${results.latency.p95}`)
  console.log(`  p99:  ${results.latency.p99}`)
  console.log(`  max:  ${results.latency.max}`)

  console.log('\nEvent Loop Lag (ms):')
  console.log(`  Samples: ${results.eventLoopLag.samples}`)
  console.log(`  Mean: ${results.eventLoopLag.mean}`)
  console.log(`  p99:  ${results.eventLoopLag.p99}`)
  console.log(`  max:  ${results.eventLoopLag.max}`)

  console.log('\nThroughput:')
  console.log(`  Total time: ${results.throughput.totalTimeMs}ms`)
  console.log(`  Requests/sec: ${results.throughput.requestsPerSecond}`)

  return results
}

// Main
async function main() {
  console.log('='.repeat(60))
  console.log('Cooperative Dispatch Benchmark')
  console.log('='.repeat(60))
  console.log('\nConfiguration:')
  console.log(`  Middleware per request: ${MIDDLEWARE_COUNT}`)
  console.log(`  CPU work iterations per middleware: ${HEAVY_WORK_ITERATIONS}`)
  console.log(`  Concurrent requests: ${CONCURRENT_REQUESTS}`)
  console.log(`  Total requests: ${TOTAL_REQUESTS}`)

  // Run baseline on port 3456
  const baseline = await runBenchmark('Baseline (no cooperative dispatch)', false, 3456)

  // Wait before next run
  await new Promise(r => setTimeout(r, 500))

  // Run with cooperative dispatch on port 3457
  const cooperative = await runBenchmark('Cooperative Dispatch Enabled', true, 3457)

  // Compare results
  console.log('\n' + '='.repeat(60))
  console.log('COMPARISON SUMMARY')
  console.log('='.repeat(60))

  const p50Change = ((parseFloat(cooperative.latency.p50) - parseFloat(baseline.latency.p50)) / parseFloat(baseline.latency.p50) * 100).toFixed(1)
  const p99Change = ((parseFloat(cooperative.latency.p99) - parseFloat(baseline.latency.p99)) / parseFloat(baseline.latency.p99) * 100).toFixed(1)
  const lagP99Change = parseFloat(baseline.eventLoopLag.p99) > 0
    ? ((parseFloat(cooperative.eventLoopLag.p99) - parseFloat(baseline.eventLoopLag.p99)) / parseFloat(baseline.eventLoopLag.p99) * 100).toFixed(1)
    : 'N/A'

  console.log('\nLatency Changes:')
  console.log(`  p50: ${baseline.latency.p50}ms -> ${cooperative.latency.p50}ms (${p50Change > 0 ? '+' : ''}${p50Change}%)`)
  console.log(`  p99: ${baseline.latency.p99}ms -> ${cooperative.latency.p99}ms (${p99Change > 0 ? '+' : ''}${p99Change}%)`)

  console.log('\nEvent Loop Lag p99:')
  console.log(`  ${baseline.eventLoopLag.p99}ms -> ${cooperative.eventLoopLag.p99}ms (${lagP99Change}%)`)

  console.log('\nExpected Outcome:')
  console.log('  - p50 may increase slightly (overhead of yielding)')
  console.log('  - p99 should improve under high concurrency')
  console.log('  - Event loop lag should be more consistent')

  console.log('\n' + '='.repeat(60))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
