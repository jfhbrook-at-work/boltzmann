// {% if selftest %}
import bole from '@entropic-dev/bole'
import { seal, unseal, defaults as ironDefaults } from '@hapi/iron'

import { Handler } from '../core/middleware'
import { Context } from '../data/context'
import { Session } from '../data/session'
import crypto from 'crypto'
import uuid from 'uuid'
// {% endif %}

let IN_MEMORY = new Map()

/* {% if selftest %} */export /* {% endif %} */interface LoadSession {
  (context: Context, id: string): Promise<Record<string, unknown>>
}

/* {% if selftest %} */export /* {% endif %} */interface SaveSession {
  (context: Context, id: string, session: Record<string, unknown>, expirySeconds: number): Promise<void>
}

const inMemorySessionLoad: LoadSession = async (_, id) => JSON.parse(IN_MEMORY.get(id))
const redisSessionLoad: LoadSession = async (context: Context, id) => {
  if (context.redisClient) {
    return JSON.parse(await context.redisClient.get(id) || '{}')
  }

  throw TypeError('redisClient was not installed')
}
const inMemorySessionSave: SaveSession = async (_, id, session) => {
  IN_MEMORY.set(id, JSON.stringify(session));
}
const redisSessionSave: SaveSession = async (context, id, session, expirySeconds) => {
  // Add 5 seconds of lag
  if (context.redisClient) {
    await context.redisClient.setex(id, expirySeconds + 5, JSON.stringify(session))
  }

  throw TypeError('redisClient was not installed')
}

let defaultSessionLoad = inMemorySessionLoad
// {% if redis %}
defaultSessionLoad = redisSessionLoad
// {% endif %}

let defaultSessionSave = inMemorySessionSave
// {% if redis %}
defaultSessionSave = redisSessionSave
// {% endif %}

/* {% if selftest %} */export /* {% endif %} */function session ({
  cookie = process.env.SESSION_ID || 'sid',
  secret = process.env.SESSION_SECRET,
  salt = process.env.SESSION_SALT,
  logger = bole('boltzmann:session'),
  load = defaultSessionLoad,
  save = defaultSessionSave,
  iron = {},
  cookieOptions = {},
  expirySeconds = 60 * 60 * 24 * 365
} = {}) {
  expirySeconds = Number(expirySeconds) || 0
  if (typeof load !== 'function') {
    throw new TypeError('`load` must be a function, got ' + typeof load)
  }

  if (typeof save !== 'function') {
    throw new TypeError('`save` must be a function, got ' + typeof save)
  }

  secret = Buffer.isBuffer(secret) ? secret : String(secret)
  if (secret.length < 32) {
    throw new RangeError('`secret` must be a string or buffer at least 32 units long')
  }

  salt = Buffer.isBuffer(salt) ? salt : String(salt)
  if (salt.length == 0) {
    throw new RangeError('`salt` must be a string or buffer at least 1 unit long; preferably more')
  }

  return (next: Handler) => {
    return async (context: Context) => {
      let _session: Session | null = null
      context._loadSession = async () => {
        if (_session) {
          return _session
        }

        const sessid = context.cookie.get(cookie)
        if (!sessid) {
          _session = new Session(null, [['created', Date.now()]])
          return _session
        }

        let clientId
        try {
          clientId = String(await unseal(sessid.value, String(secret), { ...ironDefaults, ...iron }))
        } catch (err) {
          logger.warn(`removing session that failed to decrypt; request_id="${context.id}"`)
          _session = new Session(null, [['created', Date.now()]])
          return _session
        }

        if (!clientId.startsWith('s_') || !uuid.validate(clientId.slice(2).split(':')[0])) {
          logger.warn(`caught malformed session; clientID="${clientId}"; request_id="${context.id}"`)
          throw new BadSessionError()
        }

        const id = `s:${crypto.createHash('sha256').update(clientId).update(String(salt)).digest('hex')}`

        const sessionData = await load(context, id)
        _session = new Session(clientId, Object.entries(sessionData))

        return _session
      }

      const response = await next(context)

      if (!_session) {
        return response
      }

      if (!_session.dirty) {
        return response
      }

      const needsReissue = !_session.id || _session[REISSUE]
      const issued = Date.now()
      const clientId = needsReissue ? `s_${uuid.v4()}:${issued}` : _session.id
      const id = `s:${crypto.createHash('sha256').update(clientId).update(salt).digest('hex')}`

      _session.set('modified', issued)
      await save(context, id, Object.fromEntries(_session.entries()), expirySeconds)

      if (needsReissue) {
        _iron = _iron || require('@hapi/iron')

        const sealed = await seal(clientId, secret, { ...ironDefaults, ...iron })

        context.cookie.set(cookie, {
          value: sealed,
          httpOnly: true,
          sameSite: true,
          maxAge: expirySeconds,
          ...(expirySeconds ? {} : {expires: new Date(Date.now() + 1000 * expirySeconds)}),
          ...cookieOptions
        })
      }

      return response
    }
  }
}

