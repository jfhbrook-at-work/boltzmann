void `{% if selftest %}`;
export { Handler, Adaptor, Middleware, MiddlewareConfig, Response, buildMiddleware, handler }
import { beeline, getOtelMockSpans, honeycomb, otel, otelSemanticConventions } from '../core/honeycomb'
import { HttpMetadata } from '../core/prelude'
import { HTTPMethod } from 'find-my-way'
import isDev from 'are-we-dev'
import { enforceInvariants } from '../middleware/enforce-invariants'
import { endSpan, startSpan, trace } from '../middleware/honeycomb'
import { BodyParserDefinition } from '../core/body'
import { route } from '../middleware/route'
import { Context } from '../data/context'
import { dev } from '../middleware/dev'
void `{% endif %}`;

type Response = (
  void |
  string |
  AsyncIterable<Buffer> |
  Buffer |
  { [key: string]: any } |
  (AsyncIterable<Buffer> & HttpMetadata) |
  (Buffer & HttpMetadata) |
  ({ [key: string]: any } & HttpMetadata)
)

interface Handler {
  (context: Context): Promise<any> | any,
  method?: HTTPMethod[] | HTTPMethod,
  route?: string,
  version?: string,
  decorators?: Adaptor[],
  bodyParsers?: BodyParserDefinition[],
  middleware?: MiddlewareConfig[],
  // {% if esbuild %}
  entry?: string
  // {% endif %}
}

interface Adaptor {
  (next: Handler): Handler | Promise<Handler>
}

interface Middleware {
  (...args: any[]): Adaptor
  name?: string,
  doNotTrace?: boolean
}

type MiddlewareConfig = Middleware | [Middleware, ...any[]]

async function buildMiddleware (middleware: MiddlewareConfig[], router: Handler) {
  const middlewareToSplice = (
    isDev()
    ? (mw: Middleware) => [
      // {% if honeycomb %}
      startSpan(mw),
      // {% endif %}
      dev(mw.name),
      enforceInvariants(),
      // {% if honeycomb %}
      endSpan(mw),
      // {% endif %}
    ]
    : (mw: Middleware) => [
      // {% if honeycomb %}
      startSpan(mw),
      // {% endif %}
      enforceInvariants(),
      // {% if honeycomb %}
      endSpan(mw),
      // {% endif %}
    ]
  )
  const result = middleware.reduce((lhs: Adaptor[], rhs: MiddlewareConfig) => {
    const [mw, ...args] = Array.isArray(rhs) ? rhs : [rhs]
    return [...lhs, ...middlewareToSplice(mw), mw(...args)]
  }, []).concat(middlewareToSplice(route))

  // {% if honeycomb %}
  // drop the outermost honeycombMiddlewareSpans mw.
  result.shift()
  // {% endif %}


  return result.reduceRight(async (lhs: Promise<Handler>, rhs: Adaptor): Promise<Handler> => {
    return rhs(await lhs)
  }, Promise.resolve(router))
}

function handlerSpanName(handler: Handler) {
  return `handler: ${handler.name || '<unknown>'}`
}

async function handler (context: Context) {
  const handler = context.handler as Handler
  // {% if honeycomb %}
  let beelineSpan = null
  let otelSpan = null
  let traceContext = otel.context.active()
  if (honeycomb.features.beeline) {
    beelineSpan = beeline.startSpan({
      name: handlerSpanName(handler),
      'handler.name': handler.name,
      'handler.method': String(handler.method),
      'handler.route': handler.route,
      'handler.version': handler.version || '*',
      'handler.decorators': String(handler.decorators),
      [otelSemanticConventions.SemanticResourceAttributes.SERVICE_NAME]: honeycomb.options.serviceName,
      'honeycomb.trace_type': 'beeline',
    })
  } else if (honeycomb.features.otel) {

    otelSpan = honeycomb.tracer.startSpan(
      handlerSpanName(handler),
      {
        attributes: {
          'boltzmann.http.handler.name': handler.name || '<anonymous>',
          'boltzmann.handler.method': String(handler.method),
          'boltzmann.handler.route': handler.route,
          'boltzmann.http.handler.version': handler.version || '*',
          'boltzmann.http.handler.decorators': String(handler.decorators)
        },
        kind: otel.SpanKind.SERVER
      },
      traceContext
    )
    traceContext = otel.trace.setSpan(traceContext, otelSpan)
  }

  try {
    return await otel.context.with(traceContext, async () => {
      // {% endif %}
      return await handler(context)
      // {% if honeycomb %}
    })
  } finally {
    if (beelineSpan !== null) {
      beeline.finishSpan(beelineSpan)
    } else if (otelSpan !== null) {
      otelSpan.end()
    }
  }
  // {% endif %}
}

void `{% if selftest %}`
import tap from 'tap'
type Test = (typeof tap.Test)["prototype"]
import { runserver } from '../bin/runserver'
import { inject } from '@hapi/shot'

const testMiddleware: Middleware = () => {
  return (next: Handler) => {
    return (context: Context) => {
      const span = otel.trace.getSpan(otel.context.active())
      if (span) {
        span.setAttribute('middleware_attribute', 'testing 123')
      }
      return next(context)
    }
  }
}

const testHandler: Handler = (context: Context) => {
  const span = otel.trace.getSpan(otel.context.active())
  if (span) {
    span.setAttribute('handler_attribute', 'testing 123')
  }
  return { ok: true }
}
testHandler.route = 'GET /'

/* c8 ignore next */
if (require.main === module) {
  const { test } = tap

  test('honeycomb-instrumented middlewares and handlers emit spans', async (assert: Test) => {
    const server = await runserver({
      middleware: [
        // The "trace" middleware is marked as doNotTrace, so we shouldn't
        // be creating pre-trace spans (but should get a trace span)
        trace,
        // This middleware *should* get auto-spanned
        testMiddleware
      ],
      handlers: { handler: testHandler }
    })
    const [onRequest] = server.listeners('request')

    // HTTP instrumentation won't get triggered, so we need to mock the parent
    // span

    let traceContext = otel.context.active()
    const span = honeycomb.tracer.startSpan(
      'HTTP GET',
      { kind: otel.SpanKind.SERVER, },
      traceContext
    )

    traceContext = otel.trace.setSpan(traceContext, span)

    const response = await otel.context.with(traceContext, async () => {
      return await inject(<any>onRequest, { method: 'GET', url: '/' })
    })

    span.end()
    assert.same(response.payload, '{"ok":true}')

    const spans = getOtelMockSpans(honeycomb.spanProcessor)

    const startTimes: { startTime: number, spanName: string }[] = []

    const spanAttributes = spans.map((span) => {
      const context = span.spanContext()

      startTimes.push({
        startTime: span.startTime[0] * 1000 + span.startTime[1] / 1000,
        spanName: span.name
      })

      return {
        spanName: span.name,
        serviceName: span.resource.attributes['service.name'],
        library: span.instrumentationLibrary.name,
        spanId: context.spanId,
        traceId: context.traceId,
        parentSpanId: span.parentSpanId,
        attributes: span.attributes
      }
    })

    startTimes.sort(({startTime: lhs}, {startTime: rhs}) => {
      if (rhs < lhs) {
        return 1
      }
      if (rhs > lhs) {
        return -1
      }
      return 0
    })

    const TEST_MIDDLEWARE = 0
    const ROUTE_MIDDLEWARE = 1
    const HANDLER = 2
    const REQUEST = 3

    assert.same(
      startTimes.map(({spanName}) => spanName),
      ['GET /', 'mw: testMiddleware', 'mw: route', 'handler: testHandler']
    )

    assert.same(
      spanAttributes[TEST_MIDDLEWARE],
      {
        spanName: 'mw: testMiddleware',
        serviceName: 'test-app',
        library: 'boltzmann',
        traceId: spanAttributes[REQUEST].traceId,
        spanId: spanAttributes[TEST_MIDDLEWARE].spanId,
        parentSpanId: spanAttributes[REQUEST].spanId,
        attributes: {
          // TODO: This property is getting added to the HTTP span middleware
          "middleware_attribute": "testing 123",
          "service_name": "test-app",
          "honeycomb.trace_type": "otel",
        }
      },
      'the first closed span is the test middleware'
    )
    assert.same(
      spanAttributes[ROUTE_MIDDLEWARE],
      {
        spanName: 'mw: route',
        serviceName: 'test-app',
        library: 'boltzmann',
        traceId: spanAttributes[REQUEST].traceId,
        spanId: spanAttributes[ROUTE_MIDDLEWARE].spanId,
        parentSpanId: spanAttributes[REQUEST].spanId,
        attributes: {
          "service_name": "test-app",
          "honeycomb.trace_type": "otel",
        }
      },
      'the second closed span is the route middleware'
    )
    assert.same(
      spanAttributes[HANDLER],
      {
        spanName: 'handler: testHandler',
        serviceName: 'test-app',
        library: 'boltzmann',
        traceId: spanAttributes[REQUEST].traceId,
        spanId: spanAttributes[HANDLER].spanId,
        parentSpanId: spanAttributes[REQUEST].spanId,
        attributes: {
          "handler_attribute": "testing 123",
          "service_name": "test-app",
          "honeycomb.trace_type": "otel",
          "boltzmann.http.handler.name": "testHandler",
          "boltzmann.handler.method": "GET",
          "boltzmann.handler.route": "/",
          "boltzmann.http.handler.version": "*",
          "boltzmann.http.handler.decorators": "",
        }
      }
    )
    assert.same(
      spanAttributes[REQUEST],
      {
        spanName: 'GET /',
        serviceName: 'test-app',
        library: 'boltzmann',
        traceId: spanAttributes[REQUEST].traceId,
        spanId: spanAttributes[REQUEST].spanId,
        parentSpanId: undefined,
        attributes: {
          "boltzmann.http.query": "",
          "service_name": "test-app",
          "honeycomb.trace_type": "otel"
        }
      },
      'the fourth closed span is the HTTP request span'
    )
  })
}

void `{% endif %}`
