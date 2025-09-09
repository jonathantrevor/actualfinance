import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const { ConsoleSpanExporter, BatchSpanProcessor } = tracing;

// Configuration
const serviceName = 'actual-sync-server';
const serviceVersion = process.env.npm_package_version || '25.9.0';

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
const otlpEndpointBearerToken = process.env.OTEL_EXPORTER_OTLP_BEARER_TOKEN;

const authHeader = otlpEndpointBearerToken
  ? { Authorization: `Bearer ${otlpEndpointBearerToken}` }
  : {};

// Create resource
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  [ATTR_SERVICE_VERSION]: serviceVersion,
});

// Create exporters
const otlpTraceExporter = new OTLPTraceExporter({
  url: `${otlpEndpoint}/v1/traces`,
  headers: {
    ...authHeader,
    'x-observe-target-package': 'Tracing',
  },
});

const consoleTraceExporter = new ConsoleSpanExporter();

const otlpMetricExporter = new OTLPMetricExporter({
  url: `${otlpEndpoint}/v1/metrics`,
  headers: {
    ...authHeader,
    'x-observe-target-package': 'Metrics',
  },
});

const consoleMetricExporter = new ConsoleMetricExporter();

// Initialize OpenTelemetry SDK with multiple exporters
export const sdk = new NodeSDK({
  resource,
  spanProcessors: [
    new BatchSpanProcessor(otlpTraceExporter),
    new BatchSpanProcessor(consoleTraceExporter),
  ],
  metricReader: new PeriodicExportingMetricReader({
    exporter: otlpMetricExporter,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

// Additional console metric reader for real-time terminal output
export const consoleMetricReader = new PeriodicExportingMetricReader({
  exporter: consoleMetricExporter,
  exportIntervalMillis: 5000, // Export every 5 seconds for real-time visibility
});

// Initialize Logger Provider
const loggerProvider = new LoggerProvider({
  resource,
  processors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({
        url: `${otlpEndpoint}/v1/logs`,
        headers: {
          ...authHeader,
          'x-observe-target-package': 'Logs',
        },
      }),
    ),
  ],
});

// Export logger, tracer, and meter for use in application
export const logger = logs.getLogger(serviceName);

// Get tracer and meter from the global providers after SDK initialization
export const tracer = trace.getTracer(serviceName, serviceVersion);
export const meter = metrics.getMeter(serviceName, serviceVersion);

// Export common metrics for use across the application
export const syncOperationsTotal = meter.createCounter(
  'sync_operations_total',
  {
    description: 'Total number of sync operations',
  },
);

export const fileOperationsTotal = meter.createCounter(
  'file_operations_total',
  {
    description: 'Total number of file operations',
  },
);

export const errorRateTotal = meter.createCounter('errors_total', {
  description: 'Total number of errors by type',
});

// Business and Technical Metrics as per requirements

// 1. Active users gauge (5-min window)
export const activeUsersGauge = meter.createGauge('active_users_total', {
  description: 'Number of unique users active in the last 5 minutes',
});

// 2. Business event counters
export const transactionEventsTotal = meter.createCounter('transaction_events_total', {
  description: 'Total number of transaction events (successful and failed)',
});

export const userSignupsTotal = meter.createCounter('user_signups_total', {
  description: 'Total number of user signups and completed onboardings',
});

// 3. CPU usage gauge
export const cpuUsageGauge = meter.createGauge('cpu_usage_percent', {
  description: 'CPU usage percentage',
});

// 4. Queue length/backlog gauge (placeholder for async jobs)
export const queueLengthGauge = meter.createGauge('queue_length_total', {
  description: 'Number of items in async job queues',
});

// 5. Error rate histogram by type/location
export const errorRateHistogram = meter.createHistogram('error_rate_by_type', {
  description: 'Error rates and frequencies by type and location',
});

// 6. External API request metrics
export const externalApiRequestDuration = meter.createHistogram('external_api_request_duration_seconds', {
  description: 'Duration of external API requests in seconds',
});

export const externalApiErrorsTotal = meter.createCounter('external_api_errors_total', {
  description: 'Total number of external API errors',
});

// 7. Cache hit/miss counters (placeholder)
export const cacheHitsTotal = meter.createCounter('cache_hits_total', {
  description: 'Total number of cache hits',
});

export const cacheMissesTotal = meter.createCounter('cache_misses_total', {
  description: 'Total number of cache misses',
});

// 8. Database query metrics
export const databaseQueryDuration = meter.createHistogram('database_query_duration_seconds', {
  description: 'Duration of database queries in seconds',
});

export const databaseQueryErrorsTotal = meter.createCounter('database_query_errors_total', {
  description: 'Total number of database query errors',
});

// Active users tracking (5-minute window)
const activeUsers = new Set<string>();
const userActivityTimestamps = new Map<string, number>();

export function trackActiveUser(userId: string) {
  const now = Date.now();
  activeUsers.add(userId);
  userActivityTimestamps.set(userId, now);

  // Clean up users older than 5 minutes
  const fiveMinutesAgo = now - 5 * 60 * 1000;
  for (const [user, timestamp] of userActivityTimestamps.entries()) {
    if (timestamp < fiveMinutesAgo) {
      activeUsers.delete(user);
      userActivityTimestamps.delete(user);
    }
  }

  // Update gauge
  activeUsersGauge.record(activeUsers.size);
}

// CPU usage tracking
export function updateCpuUsage() {
  try {
    const usage = process.cpuUsage();
    const totalUsage = usage.user + usage.system;
    // Convert to percentage (approximate)
    const cpuPercent = (totalUsage / 1000000) / process.uptime() * 100;
    cpuUsageGauge.record(Math.min(cpuPercent, 100));
  } catch (error) {
    console.warn('Failed to update CPU usage:', error);
  }
}

// Database query instrumentation helper
export function instrumentDatabaseQuery<T>(
  operation: string,
  table: string,
  queryFn: () => T
): T {
  const startTime = Date.now();
  const span = tracer.startSpan(`db.${operation}`, {
    attributes: {
      'db.operation': operation,
      'db.table': table,
    },
  });

  try {
    const result = queryFn();
    const duration = (Date.now() - startTime) / 1000;

    databaseQueryDuration.record(duration, {
      operation,
      table,
      status: 'success',
    });

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    return result;
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;

    databaseQueryDuration.record(duration, {
      operation,
      table,
      status: 'error',
    });

    databaseQueryErrorsTotal.add(1, {
      operation,
      table,
      error_type: (error as Error).name || 'unknown',
    });

    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
    span.end();

    throw error;
  }
}

// External API instrumentation helper
export function instrumentExternalApiCall<T>(
  dependency: string,
  operation: string,
  apiFn: () => Promise<T>
): Promise<T> {
  const startTime = Date.now();
  const span = tracer.startSpan(`external_api.${dependency}`, {
    attributes: {
      'external.dependency': dependency,
      'external.operation': operation,
    },
  });

  return apiFn()
    .then((result) => {
      const duration = (Date.now() - startTime) / 1000;

      externalApiRequestDuration.record(duration, {
        dependency,
        operation,
        status: 'success',
      });

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();

      return result;
    })
    .catch((error) => {
      const duration = (Date.now() - startTime) / 1000;

      externalApiRequestDuration.record(duration, {
        dependency,
        operation,
        status: 'error',
      });

      externalApiErrorsTotal.add(1, {
        dependency,
        operation,
        error_type: (error as Error).name || 'unknown',
      });

      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      span.end();

      throw error;
    });
}

// Initialize OpenTelemetry and return initialized components
export function initOtel() {
  try {
    logs.setGlobalLoggerProvider(loggerProvider);
    sdk.start();

    // Start periodic CPU monitoring
    setInterval(updateCpuUsage, 10000); // Update every 10 seconds

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'OpenTelemetry SDK started for Actual Budget sync server with console exporters',
      attributes: {
        service: serviceName,
        version: serviceVersion,
      },
    });

    console.log(
      'OpenTelemetry initialized successfully with console exporters for real-time output',
    );
    console.log('- Traces: Exported to both OTLP and console');
    console.log(
      '- Metrics: Exported to OTLP (console metrics require separate meter provider setup)',
    );
    console.log('- Logs: Exported to OTLP');
    console.log('- CPU monitoring: Started with 10-second intervals');
  } catch (error) {
    console.error('Error starting OpenTelemetry SDK:', error);
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error starting OpenTelemetry SDK',
      attributes: { error: (error as Error).message },
    });
    throw error;
  }
}

// Utility function to log with OpenTelemetry trace context
export function logWithTraceContext(
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: unknown,
) {
  const activeSpan = trace.getActiveSpan();
  const spanContext = activeSpan?.spanContext();

  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...(data && { data }),
    ...(spanContext && {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
    }),
  };

  console.log(JSON.stringify(logEntry, null, 2));

  // Also emit to OpenTelemetry logger
  const severityMap = {
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
  };

  logger.emit({
    severityNumber: severityMap[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes: {
      ...(data && { data: JSON.stringify(data) }),
      ...(spanContext && {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      }),
    },
  });
}

// Graceful shutdown
export function shutdownOtel(): void {
  try {
    sdk.shutdown();
    consoleMetricReader.shutdown();
    console.log('OpenTelemetry SDK shutdown successfully');
  } catch (error) {
    console.error('Error shutting down OpenTelemetry SDK:', error);
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error shutting down OpenTelemetry SDK',
      attributes: { error: (error as Error).message },
    });
    throw error;
  }
}
