import type { ProviderKind } from '../shared/types';
import { anthropicConnector } from './anthropic';
import { openAiCompatibleConnector } from './openaiCompatible';
import type { Connector } from './types';

export function getConnector(kind: ProviderKind): Connector {
  return kind === 'anthropic' ? anthropicConnector : openAiCompatibleConnector;
}
