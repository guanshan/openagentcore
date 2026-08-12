import type { TraceAttributes } from '@openagentcore/kernel';
import { OtlpTracePort, type OtlpTracePortOptions } from '@openagentcore/standard/trace';

export interface TencentApmTraceOptions extends Omit<OtlpTracePortOptions, 'resourceAttributes'> {
  readonly resourceAttributes?: TraceAttributes;
}

/** Tencent APM uses standard OTLP/HTTP; this only supplies cloud resource metadata. */
export function createTencentApmTrace(options: TencentApmTraceOptions): OtlpTracePort {
  return new OtlpTracePort({
    ...options,
    resourceAttributes: {
      'cloud.provider': 'tencent_cloud',
      ...(options.resourceAttributes ?? {}),
    },
  });
}
