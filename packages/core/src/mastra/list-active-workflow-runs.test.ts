import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { Agent } from '../agent';
import { createDurableAgent } from '../agent/durable/create-durable-agent';
import type { WorkflowRuns } from '../storage';
import { MockStore } from '../storage/mock';
import { createEmptyWorkflowSnapshot } from '../storage/workflow-snapshot';
import { createWorkflow } from '../workflows';
import type { WorkflowRunStatus } from '../workflows';
import { Mastra } from './index';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function createWorkflowRun(
  workflowName: string,
  runId: string,
  status: WorkflowRunStatus,
): WorkflowRuns['runs'][number] {
  return {
    workflowName,
    runId,
    snapshot: {
      ...createEmptyWorkflowSnapshot(runId),
      status,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Mastra listActiveWorkflowRuns', () => {
  it('lists active workflow runs without serializing independent storage reads', async () => {
    const firstWorkflow = createWorkflow({
      id: 'active-first',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    }).commit();
    const secondWorkflow = createWorkflow({
      id: 'active-second',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    }).commit();

    const mastra = new Mastra({
      logger: false,
      storage: new MockStore(),
      workflows: { firstWorkflow, secondWorkflow },
    });

    const calls: string[] = [];
    const deferreds: Array<Deferred<WorkflowRuns>> = [];

    for (const workflow of [firstWorkflow, secondWorkflow]) {
      vi.spyOn(workflow, 'listWorkflowRuns').mockImplementation(args => {
        calls.push(`${workflow.id}:${args?.status}`);
        const deferred = createDeferred<WorkflowRuns>();
        deferreds.push(deferred);
        return deferred.promise;
      });
    }

    const activeRunsPromise = mastra.listActiveWorkflowRuns();
    await Promise.resolve();

    expect(calls).toEqual([
      'active-first:running',
      'active-first:waiting',
      'active-second:running',
      'active-second:waiting',
    ]);

    const firstRunning = {
      runs: [createWorkflowRun('active-first', 'first-running', 'running')],
      total: 1,
    };
    const firstWaiting = {
      runs: [createWorkflowRun('active-first', 'first-waiting', 'waiting')],
      total: 1,
    };
    const secondRunning = {
      runs: [createWorkflowRun('active-second', 'second-running', 'running')],
      total: 1,
    };
    const secondWaiting = {
      runs: [createWorkflowRun('active-second', 'second-waiting', 'waiting')],
      total: 1,
    };

    const getDeferred = (index: number) => {
      const deferred = deferreds[index];
      if (!deferred) {
        throw new Error(`Expected deferred call at index ${index}`);
      }
      return deferred;
    };

    getDeferred(0).resolve(firstRunning);
    getDeferred(1).resolve(firstWaiting);
    getDeferred(2).resolve(secondRunning);
    getDeferred(3).resolve(secondWaiting);

    await expect(activeRunsPromise).resolves.toEqual({
      runs: [...firstRunning.runs, ...firstWaiting.runs, ...secondRunning.runs, ...secondWaiting.runs],
      total: 4,
    });
  });
});

describe('Mastra restartAllActiveWorkflowRuns', () => {
  it('does not restart durable-agent-owned workflows through generic workflow recovery', async () => {
    const userWorkflow = createWorkflow({
      id: 'user-workflow',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    }).commit();
    const durableAgent = createDurableAgent({
      agent: new Agent({
        id: 'durable-agent',
        name: 'Durable agent',
        instructions: 'Test agent',
        model: 'openai/gpt-4o',
      }),
    });
    const mastra = new Mastra({
      logger: false,
      storage: new MockStore(),
      workflows: { userWorkflow },
      agents: { durableAgent: durableAgent as any },
    });
    const durableWorkflow = durableAgent.getWorkflow();

    vi.spyOn(userWorkflow, 'listActiveWorkflowRuns').mockResolvedValue({
      runs: [createWorkflowRun(userWorkflow.id, 'user-run', 'running')],
      total: 1,
    });
    vi.spyOn(durableWorkflow, 'listActiveWorkflowRuns').mockResolvedValue({
      runs: [createWorkflowRun(durableWorkflow.id, 'durable-run', 'running')],
      total: 1,
    });
    const userRestart = vi.fn().mockResolvedValue({ status: 'success' });
    const durableRestart = vi.fn().mockResolvedValue({ status: 'success' });
    vi.spyOn(userWorkflow, 'createRun').mockResolvedValue({ restart: userRestart } as any);
    vi.spyOn(durableWorkflow, 'createRun').mockResolvedValue({ restart: durableRestart } as any);

    await mastra.restartAllActiveWorkflowRuns();

    expect(userRestart).toHaveBeenCalledOnce();
    expect(durableRestart).not.toHaveBeenCalled();
  });
});
