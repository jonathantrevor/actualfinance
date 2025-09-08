import { trace, metrics } from '@opentelemetry/api';
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
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

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

// Initialize OpenTelemetry SDK
export const sdk = new NodeSDK({
  resource: resource,
  traceExporter: new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
    headers: {
      ...authHeader,
      'x-observe-target-package': 'Tracing',
    },
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${otlpEndpoint}/v1/metrics`,
      headers: {
        ...authHeader,
        'x-observe-target-package': 'Metrics',
      },
    }),
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

// Initialize Logger Provider
const loggerProvider = new LoggerProvider({
  resource: resource,
  processors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({
        url: `${otlpEndpoint}/v1/logs`,
        headers: {
          ...authHeader,
          'x-observe-target-package': 'Logs',
        },
      })
    ),
  ],
});

// Export logger, tracer, and meter for use in application
export const logger = logs.getLogger(serviceName);

// Get tracer and meter from the global providers after SDK initialization
export const tracer = trace.getTracer(serviceName, serviceVersion);
export const meter = metrics.getMeter(serviceName, serviceVersion);

// Export common metrics for use across the application
export const syncOperationsTotal = meter.createCounter('sync_operations_total', {
  description: 'Total number of sync operations',
});

export const fileOperationsTotal = meter.createCounter('file_operations_total', {
  description: 'Total number of file operations',
});

export const errorRateTotal = meter.createCounter('errors_total', {
  description: 'Total number of errors by type',
});

// Initialize OpenTelemetry and return initialized components
export function initOtel() {
  try {
    logs.setGlobalLoggerProvider(loggerProvider);
    sdk.start();

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'OpenTelemetry SDK started for Actual Budget sync server',
      attributes: {
        service: serviceName,
        version: serviceVersion,
      },
    });

    console.log('OpenTelemetry initialized successfully');
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

// Graceful shutdown
export function shutdownOtel(): void {
  try {
    sdk.shutdown();
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
