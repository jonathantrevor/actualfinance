import express from 'express';

// OpenTelemetry imports
import { SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { logger, tracer } from './otel.js';

import { getAccountDb, isAdmin } from './account-db.js';
import { secretsService } from './services/secrets-service.js';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from './util/middlewares.js';

const app = express();

export { app as handlers };
app.use(express.json());
app.use(requestLoggerMiddleware);
app.use(validateSessionMiddleware);

app.post('/', async (req, res) => {
  const span = tracer.startSpan('secrets.set');

  try {
    let method;
    try {
      const result = getAccountDb().first(
        'SELECT method FROM auth WHERE active = 1',
      );
      method = result?.method;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Database error' });
      span.end();

      logger.emit({
        severityNumber: SeverityNumber.ERROR,
        severityText: 'ERROR',
        body: 'Failed to fetch auth method for secrets',
        attributes: { error: error.message },
      });

      console.error('Failed to fetch auth method:', error);
      return res.status(500).send({
        status: 'error',
        reason: 'database-error',
        details: 'Failed to validate authentication method',
      });
    }

    const { name, value } = req.body || {};

    span.setAttributes({
      'secrets.name': name,
      'secrets.has_value': !!value,
      'secrets.auth_method': method,
      'secrets.user_id': res.locals.user_id,
    });

    if (method === 'openid') {
      const canSaveSecrets = isAdmin(res.locals.user_id);

      span.setAttributes({
        'secrets.is_admin': canSaveSecrets,
      });

      if (!canSaveSecrets) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Not admin' });
        span.end();

        logger.emit({
          severityNumber: SeverityNumber.WARN,
          severityText: 'WARN',
          body: 'Non-admin user attempted to set secrets',
          attributes: {
            user_id: res.locals.user_id,
            secret_name: name,
          },
        });

        res.status(403).send({
          status: 'error',
          reason: 'not-admin',
          details: 'You have to be admin to set secrets',
        });

        return;
      }
    }

    secretsService.set(name, value);

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'Secret set successfully',
      attributes: {
        secret_name: name,
        user_id: res.locals.user_id,
        auth_method: method,
      },
    });

    res.status(200).send({ status: 'ok' });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error setting secret',
      attributes: {
        error: error.message,
        user_id: res.locals.user_id,
      },
    });

    throw error;
  }
});

app.get('/:name', async (req, res) => {
  const name = req.params.name;
  const keyExists = secretsService.exists(name);
  if (keyExists) {
    res.sendStatus(204);
  } else {
    res.status(404).send('key not found');
  }
});
