# Cooperative Dispatch Mode

Cooperative dispatch is an internal feature that improves tail latency (p99) under load by periodically yielding control during router dispatch. This prevents long synchronous middleware chains from monopolizing the event loop.

## Overview

When a request goes through many synchronous middleware, the event loop is blocked until all middleware complete. This can cause:

- High p99 latency for concurrent requests
- Event loop lag affecting timers and I/O
- Degraded tail performance under load

Cooperative dispatch addresses this by yielding control to the event loop periodically during dispatch, allowing other I/O operations and requests to be processed.

## When to Enable

Consider enabling cooperative dispatch when:

- Your application has many middleware per request (50+)
- You observe high p99 latency under concurrent load
- Event loop lag metrics show blocking behavior
- Tail latency matters more than median latency for your use case

**Do not enable** if:

- Your middleware stack is small (<20 middleware)
- Low median latency is critical and you can't accept any regression
- Your middleware are mostly async (already yielding naturally)

## Configuration

Cooperative dispatch is configured using the internal `cooperative dispatch` setting:

```javascript
const express = require('express')
const app = express()

// Enable with default settings
app.set('cooperative dispatch', true)

// Or with custom options
app.set('cooperative dispatch', {
  layerBudget: 50,   // Max middleware executions before yielding
  timeBudget: 2,     // Max milliseconds before yielding
  maxYields: 1000    // Safety valve - max yields per request
})
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `layerBudget` | 50 | Maximum number of synchronous middleware/layer executions before yielding control to the event loop |
| `timeBudget` | 2 | Maximum elapsed milliseconds since last yield before forcing a yield |
| `maxYields` | 1000 | Safety valve - maximum number of yields per request to prevent infinite loops |

## How It Works

1. When cooperative dispatch is enabled, Express tracks the number of middleware executed and elapsed time per request
2. After the budget is exceeded (either layer count or time), the next call to `next()` will use `setImmediate()` to yield to the event loop
3. After yielding, dispatch resumes exactly where it left off
4. All routing semantics remain unchanged:
   - `next('route')` skips to next route
   - `next('router')` exits current router
   - Error handlers (arity 4) still work correctly
   - Nested routers and mounted apps work correctly

## Performance Tradeoffs

### Expected Outcomes

| Metric | Effect |
|--------|--------|
| p50 latency | May increase 5-20% due to yield overhead |
| p99 latency | Should decrease under concurrent load |
| Event loop lag | More consistent, lower spikes |
| Throughput | May decrease slightly |

### Tuning Guidance

**Higher `layerBudget`** (e.g., 100):
- Fewer yields per request
- Less overhead
- Less improvement in p99

**Lower `layerBudget`** (e.g., 10):
- More frequent yields
- Better p99 under heavy load
- More overhead per request

**Higher `timeBudget`** (e.g., 5ms):
- Allows longer sync chains before yield
- Good for CPU-light middleware

**Lower `timeBudget`** (e.g., 1ms):
- More responsive event loop
- Better for latency-sensitive apps

## Request Abort Handling

Cooperative dispatch automatically detects when a client disconnects:

- Uses `on-finished` to detect request completion/abort
- Dispatch stops after yield if request was aborted
- Prevents wasted work on disconnected clients

## Running the Benchmark

A benchmark is provided to demonstrate the p50/p99 tradeoff:

```bash
node benchmarks/cooperative-dispatch.js
```

The benchmark:
1. Creates an app with 200 sync middleware
2. Runs 500 requests with 50 concurrent connections
3. Compares baseline vs cooperative dispatch mode
4. Reports latency percentiles and event loop lag

## Known Limitations

1. **Overhead**: Each yield adds ~1-2ms overhead. Not suitable for very low-latency requirements.

2. **Inheritance**: Mounted sub-apps don't automatically inherit the cooperative dispatch setting. Enable it on the main app.

3. **External Router**: The yielding happens when `next()` is called. If middleware never calls `next()`, no yielding occurs.

4. **Promise handlers**: Only synchronous middleware chains trigger yielding. Async middleware that use `await` already yield naturally.

## Implementation Details

The implementation works by:

1. Intercepting `req.next` when it's set by the router
2. Wrapping the `next()` function to track layer count and elapsed time
3. Using `setImmediate()` to yield when budget is exceeded
4. Resuming dispatch after the event loop processes other work

This approach:
- Requires no changes to the external `router` package
- Works with all existing middleware
- Preserves all routing semantics
- Uses per-request state (no global mutation)

## Internal API

The cooperative dispatch module exports (for testing/debugging):

```javascript
const coopDispatch = require('express/lib/cooperative-dispatch')

// Defaults
coopDispatch.defaults  // { layerBudget: 50, timeBudget: 2, maxYields: 1000 }

// State management
coopDispatch.getState(req, options)
coopDispatch.shouldYield(state)
coopDispatch.isAborted(state)
```

These are internal APIs and may change without notice.
