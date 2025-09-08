import * as expressWinston from 'express-winston';
import * as winston from 'winston';
import { trace } from '@opentelemetry/api';

import { validateSession } from './validate-user.js';

/**
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function errorMiddleware(err, req, res, next) {
  if (res.headersSent) {
    // If you call next() with an error after you have started writing the response
    // (for example, if you encounter an error while streaming the response
    // to the client), the Express default error handler closes
    // the connection and fails the request.

    // So when you add a custom error handler, you must delegate
    // to the default Express error handler, when the headers
    // have already been sent to the client
    // Source: https://expressjs.com/en/guide/error-handling.html
    return next(err);
  }

  // Get trace context for correlation
  const activeSpan = trace.getActiveSpan();
  const traceId = activeSpan?.spanContext().traceId || '';
  const spanId = activeSpan?.spanContext().spanId || '';

  const traceInfo = traceId ? ` [trace_id=${traceId} span_id=${spanId}]` : '';

  console.log(`Error on endpoint ${req.url}${traceInfo}`, {
    requestUrl: req.url,
    stacktrace: err.stack,
    trace_id: traceId,
    span_id: spanId,
    user_id: res.locals?.user_id || '',
  });
  res.status(500).send({ status: 'error', reason: 'internal-error' });
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const validateSessionMiddleware = async (req, res, next) => {
  const session = await validateSession(req, res);
  if (!session) {
    return;
  }

  res.locals = session;
  next();
};

const requestLoggerMiddleware = expressWinston.logger({
  transports: [new winston.transports.Console()],
  format: winston.format.combine(
    ...(Object.prototype.hasOwnProperty.call(process.env, 'NO_COLOR')
      ? []
      : [winston.format.colorize()]),
    winston.format.timestamp(),
    winston.format.printf(args => {
      const { timestamp, level, meta } = args;
      const { res, req } = meta;

      // Get trace context for correlation
      const activeSpan = trace.getActiveSpan();
      const traceId = activeSpan?.spanContext().traceId || '';
      const spanId = activeSpan?.spanContext().spanId || '';

      const traceInfo = traceId ? ` [trace_id=${traceId} span_id=${spanId}]` : '';

      return `${timestamp} ${level}: ${req.method} ${res.statusCode} ${req.url}${traceInfo}`;
    }),
  ),
  // Add trace correlation to metadata
  dynamicMeta: (req, res) => {
    const activeSpan = trace.getActiveSpan();
    return {
      trace_id: activeSpan?.spanContext().traceId || '',
      span_id: activeSpan?.spanContext().spanId || '',
      user_id: res.locals?.user_id || '',
    };
  },
});

export { validateSessionMiddleware, errorMiddleware, requestLoggerMiddleware };
