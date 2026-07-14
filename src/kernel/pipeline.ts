import type { RequestContext } from '../types.js';
import { DeterministicPlanner } from './planner.js';
import type { IntegrationRegistry } from './registry.js';
import { cloneRequestContext, transactProposal } from './transaction.js';
import type {
  PlanDecision,
  ProcessorIntegration,
  ProposalValidation,
  RuntimeMode,
  TransactionErrorCode,
  TransactionResult,
  TransformProposal,
} from './types.js';

export type PipelineErrorCode = TransactionErrorCode | 'proposal_failed' | 'proposal_invalid';

export interface PipelineError {
  readonly integrationId: string;
  readonly error: PipelineErrorCode;
}

export interface PipelineHooks {
  readonly mode?: RuntimeMode;
  readonly validate?: ProposalValidation;
  readonly beforeIntegration?: (
    integration: ProcessorIntegration,
    ctx: Readonly<RequestContext>,
  ) => boolean | Promise<boolean>;
}

export interface PipelineResult {
  readonly mode: RuntimeMode;
  readonly decisions: readonly PlanDecision[];
  readonly transactions: readonly TransactionResult[];
  readonly errors: readonly PipelineError[];
}

function ownedProposal(
  integration: ProcessorIntegration,
  rawProposal: TransformProposal,
  ctx: Readonly<RequestContext>,
): TransformProposal {
  const proposal = structuredClone(rawProposal);
  if (proposal == null || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new TypeError('proposal must be an object');
  }
  if (typeof proposal.id !== 'string' || proposal.id.length === 0) {
    throw new TypeError('proposal id must be a non-empty string');
  }
  if (proposal.integrationId !== integration.id) {
    throw new TypeError('proposal integration id does not match its owner');
  }
  if (!Array.isArray(proposal.regions)) {
    throw new TypeError('proposal regions must be an array');
  }
  const allowedRegions = new Set(integration.capabilities.regions);
  if (
    new Set(proposal.regions).size !== proposal.regions.length ||
    proposal.regions.some((region) => !allowedRegions.has(region))
  ) {
    throw new TypeError('proposal claims an undeclared region');
  }
  if (proposal.fidelity !== integration.capabilities.fidelity) {
    throw new TypeError('proposal fidelity does not match its capabilities');
  }
  const expectedCacheImpact = proposal.regions.length === 0
    ? 'preserve'
    : integration.capabilities.cacheImpact;
  if (proposal.cacheImpact !== expectedCacheImpact) {
    throw new TypeError('proposal cache impact does not match its capabilities');
  }
  if (proposal.patch == null || typeof proposal.patch !== 'object' || Array.isArray(proposal.patch)) {
    throw new TypeError('proposal patch must be an object');
  }
  if (
    proposal.patch.replaceBody !== undefined &&
    (proposal.patch.replaceBody == null ||
      typeof proposal.patch.replaceBody !== 'object' ||
      Array.isArray(proposal.patch.replaceBody))
  ) {
    throw new TypeError('replacement body must be an object');
  }
  if (
    proposal.patch.appendReversible !== undefined &&
    !Array.isArray(proposal.patch.appendReversible)
  ) {
    throw new TypeError('reversible handles must be an array');
  }
  if (proposal.patch.appendStages !== undefined && !Array.isArray(proposal.patch.appendStages)) {
    throw new TypeError('stage results must be an array');
  }
  if (
    proposal.patch.virtualContextIds !== undefined &&
    (!Array.isArray(proposal.patch.virtualContextIds) ||
      proposal.patch.virtualContextIds.some((id) => typeof id !== 'string'))
  ) {
    throw new TypeError('virtual context ids must be strings');
  }
  const mutatesOwnedState =
    proposal.patch.replaceBody !== undefined ||
    (proposal.patch.appendReversible?.length ?? 0) > 0 ||
    proposal.patch.virtualQueryToolNeeded === true ||
    (proposal.patch.virtualContextIds?.length ?? 0) > 0 ||
    (proposal.patch.opticalOwnsCacheControl !== undefined &&
      proposal.patch.opticalOwnsCacheControl !== ctx.opticalOwnsCacheControl);
  if (mutatesOwnedState && proposal.regions.length === 0) {
    throw new TypeError('state-changing proposal must claim a region');
  }
  return proposal;
}

/** Ordered analyze → plan → transactional-commit pipeline. */
export class IntegrationPipeline {
  constructor(
    private readonly registry: IntegrationRegistry,
    private readonly validate?: ProposalValidation,
  ) {}

  async run(ctx: RequestContext, hooks: PipelineHooks = {}): Promise<PipelineResult> {
    const mode = hooks.mode ?? 'optimize';
    const planner = new DeterministicPlanner();
    const decisions: PlanDecision[] = [];
    const transactions: TransactionResult[] = [];
    const errors: PipelineError[] = [];

    for (const integration of this.registry.ordered()) {
      if ((await hooks.beforeIntegration?.(integration, ctx)) === false) continue;
      if (mode === 'audit') continue;

      let rawProposal: TransformProposal;
      try {
        rawProposal = await integration.propose(cloneRequestContext(ctx));
      } catch {
        errors.push({ integrationId: integration.id, error: 'proposal_failed' });
        continue;
      }

      try {
        const proposal = ownedProposal(integration, rawProposal, ctx);
        const decision = planner.consider(proposal);
        decisions.push(decision);
        if (decision.status === 'rejected') continue;
        if (mode === 'shadow') {
          planner.commit(proposal);
          continue;
        }

        const transaction = await transactProposal(
          ctx,
          proposal,
          hooks.validate ?? this.validate,
          integration.commit
            ? (candidate, committedProposal, original) =>
                integration.commit!(candidate, committedProposal, original)
            : undefined,
        );
        transactions.push(transaction);
        if (transaction.status === 'committed') {
          planner.commit(proposal);
        } else {
          errors.push({ integrationId: integration.id, error: transaction.error });
        }
      } catch (error) {
        errors.push({ integrationId: integration.id, error: 'proposal_invalid' });
      }
    }

    return { mode, decisions, transactions, errors };
  }
}