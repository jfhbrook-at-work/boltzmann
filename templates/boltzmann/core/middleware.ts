void `{% if selftest %}`;
import { honeycomb } from '../core/prelude'
import { getOtelTestSpans } from '../core/honeycomb'
import { HttpMetadata } from '../core/prelude'
import { HTTPMethod } from 'find-my-way'
import isDev from 'are-we-dev'
import { otelSemanticConventions } from '../core/honeycomb'
import { enforceInvariants } from '../middleware/enforce-invariants'
import { honeycombMiddlewareSpans, trace } from '../middleware/honeycomb'
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
      honeycombMiddlewareSpans(mw),
      // {% endif %}
      dev(mw.name),
      enforceInvariants()
    ]
    : (mw: Middleware) => [
      // {% if honeycomb %}
      honeycombMiddlewareSpans(mw),
      // {% endif %}
      enforceInvariants()
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

async function handler (context: Context) {
  const handler = context.handler as Handler
  // {% if honeycomb %}

  // TODO: This check is for backwards-compatibility reasons and may be
  // removed in the future.
  // TODO: Refactor this into `honeycomb.startHandlerSpan`
  const spanOpts = honeycomb.features.otel ? {
    [otelSemanticConventions.SemanticAttributes.HTTP_METHOD]: String(handler.method),
    [otelSemanticConventions.SemanticAttributes.HTTP_ROUTE]: handler.route,
    'boltzmann.http.handler.name': handler.name,
    'boltzmann.http.handler.version': handler.version || '*',
    'boltzmann.http.handler.decorators': String(handler.decorators)
  } : {
    'handler.name': handler.name,
    'handler.method': String(handler.method),
    'handler.route': handler.route,
    'handler.version': handler.version || '*',
    'handler.decorators': String(handler.decorators)
  }

  const span = await honeycomb.startSpan(`handler: ${handler.name}`, spanOpts)

  try {
    // {% endif %}
    return await handler(context)
    // {% if honeycomb %}
  } finally {
    await span.end()
  }
  // {% endif %}
}

void `{%if selftest %}`;
export {
  Response,
  Handler,
  Adaptor,
  Middleware,
  MiddlewareConfig,
  buildMiddleware,
  handler
}
void `{% endif %}`;

void `{% if selftest %}`
import tap from 'tap'
type Test = (typeof tap.Test)["prototype"]
import { runserver } from '../bin/runserver'
import { inject } from '@hapi/shot'

// A simple test middleware that intercepts the request prior to any
// handlers seeing it
const helloMiddleware: Middleware = () => {
  return (next: Handler) => {
    return (context: Context) => {
      return 'Hello!'
    }
  }
}

// A simple test handler which throws - useful for ensuring that the handler
// isn't called
const throwingHandler: Handler = (context: Context) => {
  throw new Error('handler should not be called')
}
throwingHandler.route = 'GET /'

/* c8 ignore next */
if (require.main === module) {
  const { test } = tap

  test('honeycomb-instrumented middlewares emit spans', async (assert: Test) => {
    await honeycomb.start()

    const server = await runserver({
      middleware: [
        // The "trace" middleware is marked as doNotTrace, so we shouldn't
        // be creating pre-trace spans (but should get a trace span)
        trace,
        // This middleware *should* get auto-spanned
        helloMiddleware
      ],
      handlers: { handler: throwingHandler }
    })
    const [onRequest] = server.listeners('request')
    const response = await inject(<any>onRequest, { method: 'GET', url: '/' })

    assert.same(response.payload, 'Hello!')

    await honeycomb.stop()

    const spans = getOtelTestSpans(honeycomb.spanProcessor)

    // TODO: Clean this up when I'm confident in the asserts
    assert.same(spans, [], 'un-comment this to render all spans')

    const instrumentationSpans = spans.map(span => {
      return {
        spanName: span.name,
        library: span.instrumentationLibrary.name
      }
    }).filter(
      span => span.library.match(/^@opentelemetry\/instrumentation-/)
    )

    const boltzmannSpans = spans.map(span => {
      const context = span.spanContext()

      return {
        spanName: span.name,
        serviceName: String(span.resource.attributes['service.name']).split(':')[0],
        library: span.instrumentationLibrary.name,
        spanId: context.spanId,
        traceId: context.traceId,
        parentSpanId: span.parentSpanId,
        attributes: span.attributes
      }
 
    }).filter(
      span => !span.library.match(/^@opentelemetry\/instrumentation-/)
    )

    assert.same(
      instrumentationSpans,
      [
        // These are all grpc api client calls - very meta!
        {
          spanName: 'HTTP GET',
          library: '@opentelemetry/instrumentation-http'
        }
      ],
      'auto-instrumentation is emitting expected spans'
    )

    assert.same(
      boltzmannSpans,
      [
        // The middleware span
        {
          spanName: 'mw: helloMiddleware',
          serviceName: 'test-app',
          library: 'boltzmann',
          traceId: boltzmannSpans[0].traceId,
          spanId: boltzmannSpans[0].spanId,
          parentSpanId: undefined,
          // TODO: There *should* be attributes here, no?
          attributes: {}
        },
        // The request-level parent span
        {
          spanName: 'GET /',
          serviceName: 'test-app',
          library: 'boltzmann',
          traceId: boltzmannSpans[0].traceId,
          spanId: boltzmannSpans[0].spanId,
          parentSpanId: boltzmannSpans[0].spanId,
          attributes: {
            "http.host": "localhost",
            "http.url": "http://localhost/",
            "http.client_ip": "",
            "http.method": "GET",
            "http.scheme": "http:",
            "http.route": "/",
            "boltzmann.http.query": "",
            "http.status_code": "200",
          }
        },
     ],
      "There are two nested spans, in the same trace, with service name and attributes"
    )
  })
}

void `{% endif %}`
