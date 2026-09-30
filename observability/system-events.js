import { logEvent } from './telemetry.js';
import { createSystemTelemetryHook } from '../core/system-telemetry.js';

export const logSystemEvent=createSystemTelemetryHook({emit:logEvent});
