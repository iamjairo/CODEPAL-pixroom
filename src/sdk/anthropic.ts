import {
  wrapProviderClient,
  type ProviderSdkClient,
  type WrappedPixroomClient,
  type WithPixroomOptions,
} from './client.js';

/** Route an existing Anthropic SDK client through an embedded Pixroom runtime. */
export function withPixroom<T extends ProviderSdkClient>(
  client: T,
  options: WithPixroomOptions = {},
): Promise<WrappedPixroomClient<T>> {
  return wrapProviderClient('anthropic', client, options);
}

export type {
  PixroomClientHandle,
  ProviderSdkClient,
  WrappedPixroomClient,
  WithPixroomOptions,
} from './client.js';