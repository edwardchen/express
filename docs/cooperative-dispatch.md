# Cooperative router dispatch (opt-in)

Cooperative router dispatch is an internal, opt-in mode that periodically
yields during long synchronous routing runs. This can improve tail latency
(p99) under load by preventing a single request from monopolizing the event
loop, at the expense of extra scheduling overhead that can regress median
latency (p50).

## When to enable it

Enable this when you observe long synchronous middleware/route chains that
cause event-loop lag or high p99 latency under concurrency. Leave it disabled
if you only care about peak throughput or lowest p50 latency.

## Configuration (internal)

Cooperative dispatch is configured per router. The app router can be configured
via an internal setting, while nested routers can opt in via their constructor
options.

```js
// App router (internal setting)
app.set('cooperative router dispatch', {
  maxLayers: 50,
  maxTimeMs: 5,
  maxYields: 1000
})

// Nested router (per-router opt-in)
const router = express.Router({
  cooperativeDispatch: {
    maxLayers: 50,
    maxTimeMs: 5,
    maxYields: 1000
  }
})
```

### Budget controls

* `maxLayers`: maximum number of layers to process synchronously before
  yielding.
* `maxTimeMs`: elapsed time budget (in milliseconds) before yielding.
* `maxYields`: safety valve to stop yielding after too many resumes.

If either `maxLayers` or `maxTimeMs` is exceeded, the dispatcher yields via
`setImmediate` and then resumes where it left off.

## Tradeoffs and tuning

* Lower `maxLayers`/`maxTimeMs` improves p99 latency and reduces event-loop lag,
  but adds scheduling overhead and can reduce throughput or regress p50.
* Higher budgets reduce overhead but yield less often, which can allow long
  synchronous chains to monopolize the event loop.

## Known limitations

* Cooperative dispatch only yields between layers; synchronous work inside an
  individual handler is still blocking.
* If a router is not opted in, it will not yield (even if a parent router is
  opted in).
