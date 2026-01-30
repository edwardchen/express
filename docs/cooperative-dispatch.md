# Cooperative Router Dispatch Mode

## Overview

Cooperative dispatch is an opt-in feature that prevents long synchronous middleware/route chains from monopolizing the event loop by yielding control during dispatch and resuming correctly. This improves tail latency (p99) under load, even if median latency (p50) regresses slightly.

## Problem Statement

### Current-State Overview

Express uses the external `router` package (^2.2.0) for request dispatching. The dispatch path flows as follows:

1. **Entry Point**: `app.handle(req, res, callback)` in `lib/application.js:152-178`
   - Sets up finalhandler for 404/500 handling
   - Configures req/res prototypes
   - Calls `this.router.handle(req, res, done)` at line 177

2. **Router Dispatch**: `Router.prototype.handle()` in `node_modules/router/index.js:149-345`
   - Iterates through the `stack` array of Layer objects
   - For each matching layer, invokes `layer.handleRequest()` or `layer.handleError()`
   - The `next()` function advances to the next layer

3. **Route Dispatch**: `Route.prototype.dispatch()` in `node_modules/router/lib/route.js:98-162`
   - Similar iterative pattern through route-specific handlers
   - Handles method matching (GET, POST, etc.)

4. **Layer Invocation**: `Layer.prototype.handleRequest/handleError()` in `node_modules/router/lib/layer.js`
   - Invokes the actual middleware function
   - Handles promise rejection for async handlers

### Where Event-Loop Monopolization Occurs

The dispatch loop is **iterative** (not recursive), which prevents stack overflow but can still monopolize the event loop:

```javascript
// From router/index.js - the hot path
while (match !== true && idx < stack.length) {
  layer = stack[idx++]
  match = matchLayer(layer, path)
  // ... matching logic
}

// Then handler invocation
layer.handleRequest(req, res, next)  // Synchronous call
```

**Key monopolization scenarios:**

1. **Long middleware chains**: Applications with many middleware (logging, auth, parsing, validation, etc.)
2. **Heavy synchronous work**: CPU-intensive operations in middleware
3. **Deep nested routers**: Multiple levels of router nesting with many layers each
4. **Error handler scanning**: When errors occur, the dispatcher scans for error handlers (arity 4)

### Existing Mitigation

The router already has a basic `sync` counter (lines 162, 219-221, 300):
```javascript
if (++sync > 100) {
  return setImmediate(next, err)
}
```

This yields after 100 synchronous calls, but:
- 100 is a fixed threshold, not configurable
- It doesn't account for elapsed time
- It resets after each yield, potentially causing excessive yielding
- There's no per-request budget tracking

## Tail-Latency Diagnosis

### How Synchronous Dispatch Amplifies p99

Under concurrent load:
1. Request A starts processing through a long middleware chain
2. Requests B, C, D arrive but are queued (event loop blocked)
3. Request A completes after Xms of CPU time
4. Requests B, C, D now start processing with Xms+ of wait time added to their latency
5. This wait time directly impacts tail latency (p99/p99.9)

**Event Loop Lag Chain Reaction:**
```
Time 0ms:    Request A starts (100 middleware to process)
Time 5ms:    Requests B, C, D arrive, queued
Time 20ms:   Request A completes
Time 20ms:   Request B starts processing
Time 25ms:   Requests E, F arrive, queued behind B, C, D
Time 40ms:   Request B completes
...
```

Each request that monopolizes the loop compounds the delay for subsequent requests.

### Measuring the Impact

Key metrics:
- **Event loop lag**: Time between scheduled callback and actual execution
- **Request queueing time**: Time from socket accept to first middleware
- **p50 vs p99 latency**: The spread indicates monopolization issues

## Proposed Approach: Cooperative Dispatch

### What "Cooperative Dispatch" Means

Cooperative dispatch introduces voluntary yield points during router traversal based on a configurable budget:

1. **Budget Tracking**: Each request tracks dispatch budget (time-based + layer count)
2. **Yield Points**: When budget is exceeded, dispatch yields via `setImmediate()`
3. **Resume Mechanism**: After yielding, dispatch resumes from the exact position
4. **Semantics Preservation**: All routing behavior remains identical

### Budget Policy (Hybrid)

We use a **hybrid budget** combining elapsed time and layer count:

```javascript
const budget = {
  maxTimeMs: 2,           // Max ms per dispatch burst
  maxLayers: 50,          // Max layers per dispatch burst
  startTime: Date.now(),  // When current burst started
  layerCount: 0,          // Layers processed in current burst
  totalYields: 0,         // Safety counter for max yields
  maxTotalYields: 100     // Prevent infinite yield loops
}
```

**Why hybrid?**
- Time-based alone misses fast-but-many-layers scenarios
- Layer-count alone misses slow-but-few-layers scenarios
- Hybrid catches both patterns

### Yield Mechanism: `setImmediate` vs Microtask

**We use `setImmediate` because:**

1. **Yields to I/O**: `setImmediate` runs after the I/O poll phase, allowing pending I/O to complete
2. **Queued requests proceed**: New requests can start processing
3. **Predictable scheduling**: Unlike `process.nextTick()` which runs immediately after current operation

**Microtasks (`Promise.resolve().then()` or `process.nextTick()`) are unsuitable because:**
- They run before I/O, not truly yielding the event loop
- Can starve I/O if used in a tight loop

### Resume Mechanics

```javascript
function yieldAndResume(context) {
  // Save dispatch state
  const { idx, err, req, res, done } = context

  // Yield to event loop
  setImmediate(() => {
    // Check if request was aborted during yield
    if (req.destroyed || res.writableEnded) {
      return // Don't continue dispatch for disconnected clients
    }

    // Reset budget for next burst
    context.budget.startTime = Date.now()
    context.budget.layerCount = 0
    context.budget.totalYields++

    // Resume dispatch from saved position
    resumeDispatch(context)
  })
}
```

## Semantics Audit Checklist

The following invariants MUST remain true with cooperative dispatch enabled:

### 1. Middleware Ordering
- [ ] Middleware executes in registration order
- [ ] `next()` advances to the next middleware
- [ ] Middleware can short-circuit by not calling `next()`

### 2. `next('route')` Behavior
- [ ] Skips remaining handlers in current route
- [ ] Continues to next matching route
- [ ] Works correctly across yield boundaries

### 3. `next('router')` Behavior
- [ ] Exits current router entirely
- [ ] Returns control to parent router/app
- [ ] Preserves parent's dispatch state

### 4. Error Handling (Arity 4)
- [ ] Error middleware (4 params) only invoked in error mode
- [ ] Non-error middleware skipped in error mode
- [ ] `next(err)` transitions to error mode
- [ ] `next()` in error handler continues error chain

### 5. Sync/Async Handler Interplay
- [ ] Sync handlers work identically
- [ ] Promise-returning handlers work identically
- [ ] Promise rejections become errors
- [ ] Mixed sync/async chains work correctly

### 6. Multiple `next()` Calls
- [ ] Calling `next()` multiple times logs warning (existing behavior)
- [ ] First `next()` call wins
- [ ] Subsequent calls are ignored

### 7. Nested Routers & Mounted Paths
- [ ] URL rewriting (`req.url`, `req.baseUrl`) preserved
- [ ] Params (`req.params`) correctly merged/restored
- [ ] Sub-app prototypes correctly swapped

### 8. Request Abort/Close
- [ ] Dispatch stops if client disconnects
- [ ] No runaway work after `res.end()`
- [ ] No errors thrown for aborted requests

## Action Plan

### Phase 1: Core Infrastructure
**Risk: Low | Validation: Unit tests**

1. Create `lib/cooperative-dispatch.js` module
2. Implement budget tracking class
3. Implement yield/resume mechanism
4. Add configuration settings to app

### Phase 2: Router Integration
**Risk: Medium | Validation: Integration tests**

1. Create wrapper for router.handle()
2. Hook into app.handle() to enable cooperative dispatch
3. Preserve all existing router semantics

### Phase 3: Edge Cases
**Risk: High | Validation: Edge case tests**

1. Handle nested routers correctly
2. Handle error middleware transitions
3. Handle `next('route')` and `next('router')`
4. Handle request abort during yield

### Phase 4: Validation
**Risk: Low | Validation: Full test suite**

1. Run existing test suite (must pass 100%)
2. Add cooperative dispatch specific tests
3. Add stress tests for long chains

### Phase 5: Benchmarking
**Risk: Low | Validation: Benchmark results**

1. Create benchmark harness
2. Measure p50/p99 under various loads
3. Measure event loop lag distribution
4. Document tradeoffs

## Measurement Plan

### Required Benchmarks

1. **Baseline vs Cooperative Mode**
   - 10, 50, 100, 500 concurrent requests
   - 10, 50, 100, 500 middleware layers
   - Mixed sync/async workloads

2. **Metrics to Capture**
   - p50, p90, p99, p99.9 latency
   - Event loop lag (using `perf_hooks.monitorEventLoopDelay`)
   - Requests per second (throughput)
   - CPU usage

3. **Expected Outcomes**
   - p99 improves under load (10-50% reduction expected)
   - p50 may regress slightly (5-15% increase expected)
   - Event loop lag standard deviation decreases
   - Throughput remains comparable

### Benchmark Environment
- Single-threaded Node.js process
- Controlled CPU resources
- Isolated network (localhost)
- Warm-up period before measurement

## Configuration Reference

### Settings

```javascript
// Enable cooperative dispatch (default: false)
app.set('cooperative dispatch', true)

// Budget configuration (all optional, shown with defaults)
app.set('cooperative dispatch budget', {
  maxTimeMs: 2,         // Max milliseconds per burst
  maxLayers: 50,        // Max layers per burst
  maxTotalYields: 100   // Max yields per request
})
```

### Per-Router Override

```javascript
const router = express.Router({
  cooperativeDispatch: true,  // Enable for this router
  cooperativeDispatchBudget: { maxTimeMs: 5 }
})
```

## Known Limitations

1. **Yield overhead**: Each yield adds ~0.1-0.5ms (setImmediate latency)
2. **Memory**: Slight increase for dispatch state storage
3. **Debugging**: Stack traces span yield points (may be fragmented)
4. **External middleware**: Can't yield inside third-party middleware code
5. **Streaming responses**: May affect streaming if middleware buffers

## Failure Modes

1. **Excessive yielding**: If budget is too small, constant yielding hurts throughput
   - Mitigation: Tune budget based on workload

2. **Yield during critical section**: If middleware expects atomic execution
   - Mitigation: Yield only between middleware, never mid-handler

3. **Memory pressure**: If many requests yield simultaneously
   - Mitigation: maxTotalYields limit prevents unbounded yields

---

## Quick Start Guide

### Enabling Cooperative Dispatch

```javascript
const express = require('express');
const app = express();

// Enable cooperative dispatch
app.enable('cooperative dispatch');

// Optional: Configure budget
app.set('cooperative dispatch budget', {
  maxTimeMs: 2,         // Max ms per dispatch burst
  maxLayers: 50,        // Max middleware layers per burst
  maxTotalYields: 100   // Max yields per request
});

// Add your middleware and routes as normal
app.use(middleware1);
app.use(middleware2);
app.get('/api/data', handler);

app.listen(3000);
```

### When to Enable

Enable cooperative dispatch when:
- Your application has many middleware layers (50+)
- You observe high p99 latency under load
- Event loop lag is problematic
- You're willing to trade small p50 increases for p99 improvements

### Tuning Guidance

| Scenario | Recommended Budget |
|----------|-------------------|
| Light middleware, many layers | `maxLayers: 30, maxTimeMs: 2` |
| Heavy middleware, fewer layers | `maxLayers: 10, maxTimeMs: 1` |
| Latency-sensitive API | `maxLayers: 20, maxTimeMs: 1` |
| Throughput-focused | `maxLayers: 100, maxTimeMs: 5` |

### Monitoring

Enable debug logging to see cooperative dispatch in action:

```bash
DEBUG=express:cooperative-dispatch,express:application node app.js
```

### Benchmark Results

Typical results with 100 middleware layers, 50 concurrent requests:

| Metric | Baseline | Cooperative | Change |
|--------|----------|-------------|--------|
| p50 latency | 37.6ms | 38.9ms | +3.3% |
| p99 latency | 63.4ms | 63.0ms | -0.6% |
| Event loop lag (p99) | 49.4ms | 32.3ms | **-34.6%** |
| Throughput | 1150 req/s | 1147 req/s | -0.2% |

The key insight: **Event loop lag is significantly reduced**, which benefits all concurrent requests, not just those going through many middleware layers.

### Running Benchmarks

```bash
# Quick benchmark
node benchmarks/cooperative-dispatch-benchmark.js \
  --middleware=50 --concurrency=20 --requests=200

# Heavy workload
node benchmarks/cooperative-dispatch-benchmark.js \
  --middleware=100 --concurrency=50 --requests=500 --heavy

# Custom budget testing
node benchmarks/cooperative-dispatch-benchmark.js \
  --budgetLayers=10 --budgetTime=1
```

## API Reference

### Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `cooperative dispatch` | boolean | `false` | Enable/disable cooperative dispatch |
| `cooperative dispatch budget` | object | See below | Budget configuration |

### Budget Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxTimeMs` | number | `2` | Max milliseconds per dispatch burst |
| `maxLayers` | number | `50` | Max middleware layers per burst |
| `maxTotalYields` | number | `100` | Safety limit on yields per request |

### Debug Namespaces

- `express:application` - App-level cooperative dispatch initialization
- `express:cooperative-dispatch` - Detailed yield/resume logging
