#!/usr/bin/env node
'use strict'

const http = require('node:http')
const { monitorEventLoopDelay, performance } = require('node:perf_hooks')
const express = require('..')

const CONCURRENCY = 50
const REQUESTS = 1000
const CHAIN_LENGTH = 400

function percentile (values, p) {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

function buildApp (cooperative) {
  const app = express()

  if (cooperative) {
    app.set('cooperative router dispatch', {
      maxLayers: 50,
      maxTimeMs: 5,
      maxYields: 1000
    })
  }

  for (let i = 0; i < CHAIN_LENGTH; i++) {
    app.use(function (req, res, next) {
      next()
    })
  }

  app.get('/', function (req, res) {
    res.end('ok')
  })

  return app
}

function runLoad (port) {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY })
    const latencies = []
    let completed = 0
    let inFlight = 0

    function launch () {
      if (completed >= REQUESTS) {
        if (inFlight === 0) resolve(latencies)
        return
      }

      inFlight++
      const start = performance.now()
      const req = http.get({ port, path: '/', agent }, (res) => {
        res.resume()
        res.on('end', () => {
          latencies.push(performance.now() - start)
          inFlight--
          completed++
          launch()
        })
      })

      req.on('error', (err) => {
        inFlight--
        reject(err)
      })
    }

    for (let i = 0; i < CONCURRENCY; i++) {
      launch()
    }
  })
}

async function runScenario (name, cooperative) {
  const app = buildApp(cooperative)
  const server = http.createServer(app)
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()

  const cpuStart = process.cpuUsage()

  await new Promise((resolve) => server.listen(0, resolve))
  const port = server.address().port
  const latencies = await runLoad(port)

  const cpuEnd = process.cpuUsage(cpuStart)

  histogram.disable()
  await new Promise((resolve) => server.close(resolve))

  return {
    name,
    p50: percentile(latencies, 50),
    p99: percentile(latencies, 99),
    elMin: histogram.min / 1e6,
    elMax: histogram.max / 1e6,
    elMean: histogram.mean / 1e6,
    cpuUserMs: cpuEnd.user / 1000,
    cpuSystemMs: cpuEnd.system / 1000
  }
}

async function main () {
  const baseline = await runScenario('baseline', false)
  const cooperative = await runScenario('cooperative', true)

  console.log('Results (ms):')
  console.table([baseline, cooperative])
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
