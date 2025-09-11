import express from 'express';

// OpenTelemetry imports
import { SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { logger, tracer } from './otel.js';

import {
  bootstrap,
  needsBootstrap,
  getLoginMethod,
  listLoginMethods,
  getUserInfo,
  getActiveLoginMethod,
} from './account-db.js';
import { isValidRedirectUrl, loginWithOpenIdSetup } from './accounts/openid.js';
import { changePassword, loginWithPassword } from './accounts/password.js';
import {
  errorMiddleware,
  requestLoggerMiddleware,
} from './util/middlewares.js';
import { validateAuthHeader, validateSession } from './util/validate-user.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(errorMiddleware);
app.use(requestLoggerMiddleware);
export { app as handlers };

// Non-authenticated endpoints:
//
// /needs-bootstrap
// /boostrap (special endpoint for setting up the instance, cant call again)
// /login

app.get('/needs-bootstrap', (req, res) => {
  const span = tracer.startSpan('account.needs-bootstrap');

  try {
    const availableLoginMethods = listLoginMethods();
    const bootstrapped = !needsBootstrap();

    span.setAttributes({
      'account.bootstrapped': bootstrapped,
      'account.available_login_methods_count': availableLoginMethods.length,
      'account.multiuser': getActiveLoginMethod() === 'openid',
    });

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'Bootstrap status checked',
      attributes: {
        bootstrapped,
        available_methods: availableLoginMethods.length,
      },
    });

    res.send({
      status: 'ok',
      data: {
        bootstrapped,
        loginMethod:
          availableLoginMethods.length === 1
            ? availableLoginMethods[0].method
            : getLoginMethod(),
        availableLoginMethods,
        multiuser: getActiveLoginMethod() === 'openid',
      },
    });

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error checking bootstrap status',
      attributes: { error: error.message },
    });

    throw error;
  }
});

app.post('/bootstrap', async (req, res) => {
  const span = tracer.startSpan('account.bootstrap');

  try {
    span.setAttributes({
      'account.bootstrap.has_body': !!req.body,
    });

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'Bootstrap attempt started',
      attributes: {
        has_body: !!req.body,
      },
    });

    const boot = await bootstrap(req.body);

    if (boot?.error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: boot.error });
      span.end();

      logger.emit({
        severityNumber: SeverityNumber.ERROR,
        severityText: 'ERROR',
        body: 'Bootstrap failed',
        attributes: { error: boot.error },
      });

      res.status(400).send({ status: 'error', reason: boot?.error });
      return;
    }

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'Bootstrap completed successfully',
    });

    res.send({ status: 'ok', data: boot });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error during bootstrap',
      attributes: { error: error.message },
    });

    throw error;
  }
});

app.get('/login-methods', (req, res) => {
  const methods = listLoginMethods();
  res.send({ status: 'ok', methods });
});

app.post('/login', async (req, res) => {
  const span = tracer.startSpan('account.login');

  try {
    const loginMethod = getLoginMethod(req);

    span.setAttributes({
      'account.login.method': loginMethod,
    });

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'Login attempt started',
      attributes: {
        login_method: loginMethod,
      },
    });

    console.log('Logging in via ' + loginMethod);
    let tokenRes = null;
    switch (loginMethod) {
      case 'header': {
        const headerVal = req.get('x-actual-password') || '';
        const obfuscated =
          '*'.repeat(headerVal.length) || 'No password provided.';
        console.debug('HEADER VALUE: ' + obfuscated);

        span.setAttributes({
          'account.login.header.has_password': headerVal !== '',
        });

        if (headerVal === '') {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'Invalid header - no password' });
          span.end();

          logger.emit({
            severityNumber: SeverityNumber.WARN,
            severityText: 'WARN',
            body: 'Login failed - invalid header',
            attributes: { reason: 'no-password' },
          });

          res.send({ status: 'error', reason: 'invalid-header' });
          return;
        } else {
          if (validateAuthHeader(req)) {
            tokenRes = loginWithPassword(headerVal);
          } else {
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'Proxy not trusted' });
            span.end();

            logger.emit({
              severityNumber: SeverityNumber.WARN,
              severityText: 'WARN',
              body: 'Login failed - proxy not trusted',
            });

            res.send({ status: 'error', reason: 'proxy-not-trusted' });
            return;
          }
        }
        break;
      }
    case 'openid': {
      span.setAttributes({
        'account.login.openid.has_return_url': !!req.body.returnUrl,
      });

      if (!isValidRedirectUrl(req.body.returnUrl)) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Invalid redirect URL' });
        span.end();

        logger.emit({
          severityNumber: SeverityNumber.WARN,
          severityText: 'WARN',
          body: 'OpenID login failed - invalid redirect URL',
        });

        res
          .status(400)
          .send({ status: 'error', reason: 'Invalid redirect URL' });
        return;
      }

      const { error, url } = await loginWithOpenIdSetup(
        req.body.returnUrl,
        req.body.password,
      );
      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error });
        span.end();

        logger.emit({
          severityNumber: SeverityNumber.ERROR,
          severityText: 'ERROR',
          body: 'OpenID login setup failed',
          attributes: { error },
        });

        res.status(400).send({ status: 'error', reason: error });
        return;
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();

      logger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'OpenID login setup successful',
      });

      res.send({ status: 'ok', data: { returnUrl: url } });
      return;
    }

    default:
      tokenRes = loginWithPassword(req.body.password);
      break;
  }
  const { error, token } = tokenRes;

  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Login failed',
      attributes: { error },
    });

    res.status(400).send({ status: 'error', reason: error });
    return;
  }

  span.setStatus({ code: SpanStatusCode.OK });
  span.end();

  logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: 'Login successful',
    attributes: { login_method: loginMethod },
  });

  res.send({ status: 'ok', data: { token } });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error during login',
      attributes: { error: error.message },
    });

    throw error;
  }
});

app.post('/change-password', (req, res) => {
  const span = tracer.startSpan('account.change-password');

  try {
    const session = validateSession(req, res);
    if (!session) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Invalid session' });
      span.end();
      return;
    }

    span.setAttributes({
      'account.user_id': session.user_id,
      'account.change_password.has_password': !!req.body.password,
    });

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'Password change attempt',
      attributes: {
        user_id: session.user_id,
      },
    });

    const { error } = changePassword(req.body.password);

    if (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      span.end();

      logger.emit({
        severityNumber: SeverityNumber.ERROR,
        severityText: 'ERROR',
        body: 'Password change failed',
        attributes: { error, user_id: session.user_id },
      });

      res.status(400).send({ status: 'error', reason: error });
      return;
    }

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'Password changed successfully',
      attributes: { user_id: session.user_id },
    });

    res.send({ status: 'ok', data: {} });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error during password change',
      attributes: { error: error.message },
    });

    throw error;
  }
});

app.get('/validate', (req, res) => {
  const span = tracer.startSpan('account.validate');

  try {
    const session = validateSession(req, res);
    if (session) {
      span.setAttributes({
        'account.user_id': session.user_id,
        'account.auth_method': session.auth_method,
      });

      const user = getUserInfo(session.user_id);
      if (!user) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'User not found' });
        span.end();

        logger.emit({
          severityNumber: SeverityNumber.ERROR,
          severityText: 'ERROR',
          body: 'Session validation failed - user not found',
          attributes: { user_id: session.user_id },
        });

        res.status(400).send({ status: 'error', reason: 'User not found' });
        return;
      }

      span.setAttributes({
        'account.user_name': user.user_name,
        'account.role': user.role,
      });

      logger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'Session validated successfully',
        attributes: {
          user_id: session.user_id,
          user_name: user.user_name,
          role: user.role,
        },
      });

      res.send({
        status: 'ok',
        data: {
          validated: true,
          userName: user?.user_name,
          permission: user?.role,
          userId: session?.user_id,
          displayName: user?.display_name,
          loginMethod: session?.auth_method,
        },
      });

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Invalid session' });
      span.end();

      logger.emit({
        severityNumber: SeverityNumber.WARN,
        severityText: 'WARN',
        body: 'Session validation failed - invalid session',
      });
    }
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error during session validation',
      attributes: { error: error.message },
    });

    throw error;
  }
});
