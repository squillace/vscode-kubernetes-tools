'use strict';

import { create as kubectlCreate, Kubectl } from '../../kubectl';

import { fs } from '../../fs';
import { shell } from '../../shell';
import { host } from '../../host';
import { findAllPods, tryFindKindNameFromEditor, FindPodsResult } from '../../extension';
import { QuickPickOptions } from 'vscode';
import * as portFinder from 'portfinder';

const kubectl = kubectlCreate(host, fs, shell);
const MAX_PORT_COUNT = 65535;

interface PortForwardFindPodsResult extends FindPodsResult  {
    readonly fromOpenDocument?: boolean;
}

/**
 * Implements port-forwarding to a target pod in the `default` namespace.
 * @param explorerNode The treeview explorer node, if invoked from
 * tree view.
 */
export async function portForwardKubernetes (explorerNode?: any): Promise<void> {
    if (explorerNode) {
        // The port forward option only appears on pod level workloads in the tree view.
        const podName = explorerNode.id;
        const targetPort = await promptForPort(podName);
        portForwardToPod(podName, Number(targetPort));
        return;
    } else {
        let portForwardablePods: PortForwardFindPodsResult;

        try {
            portForwardablePods = await findPortForwardablePods();
        } catch (e) {
            host.showErrorMessage("Error while fetching pods for port-forward");
            throw e;
        }

        if (!portForwardablePods.succeeded) {
            host.showInformationMessage("Error while fetching pods for port-forward");
        }

        let pods = portForwardablePods.pods;

        if (portForwardablePods.fromOpenDocument && pods.length === 1) {
            // The pod is described by the open document. Skip asking which pod to use and go straight to port-forward.
            const podSelection = portForwardablePods[0];
            const targetPort = await promptForPort(podSelection);
            portForwardToPod(podSelection, Number(targetPort));
            return;
        }

        let podSelection;

        try {
            const podNames:string[] = pods.map((podObj) => podObj.metadata.name);
            podSelection = await host.showQuickPick(
                podNames,
                { placeHolder: "Select a pod to port-forward to" }
            );
        } catch (e) {
            host.showErrorMessage("Error while selecting pod for port-forward");
            throw e;
        }

        if (podSelection === undefined) {
            host.showErrorMessage("Error while selecting pod for port-forward");
            return;
        }

        const targetPort = await promptForPort(podSelection);
        portForwardToPod(podSelection, Number(targetPort));
    }
}

/**
 * Given a pod name, prompts the user on what port to port-forward to, and validates numeric input.
 * @param podSelection The pod to port-forward to.
 */
async function promptForPort (podSelection: string) {
    let targetPort: string;

    try {
        targetPort = await host.showInputBox(<QuickPickOptions>{
            placeHolder: "8001",
            prompt: `The numeric port to forward to on pod ${podSelection}`,
            validateInput: (value) => {
                if (Number(value) && Number(value) <= MAX_PORT_COUNT) {
                    return undefined;
                }

                return `Invalid port. Please enter a valid numerical port:  1 – ${MAX_PORT_COUNT}`;
            }
        });
    } catch (e) {
        host.showErrorMessage("Could not validate on input port");
    }

    return targetPort;
}

/**
 * Returns one or all available port-forwardable pods.
 * Checks the open document and returns a pod name, if it can find one.
 */
async function findPortForwardablePods () : Promise<PortForwardFindPodsResult> {
    let kindFromEditor = tryFindKindNameFromEditor();
    let kind, podName;

    // Find the pod type from the open editor.
    if (kindFromEditor !== null) {
        let parts = kindFromEditor.split('/');
        kind = parts[0];
        podName = parts[1];

        // Not a pod type, so not port-forwardable, fallback to looking
        // up all pods.
        if (kind !== 'pods') {
            return await findAllPods();
        }

        return <PortForwardFindPodsResult>{
            succeeded: true,
            pods: [podName],
            fromOpenDocument: true
        };
    }

    return await findAllPods() as PortForwardFindPodsResult;
}

/**
 * Invokes kubectl port-forward.
 * @param podName The pod name.
 * @param targetPort The target port to forward to.
 * @param localPort (Optional) local port. If not provided, an unbound port is used.
 */
export async function portForwardToPod (podName: string, targetPort: number, localPort?: number) {
    console.log(`port forwarding to pod ${podName} at port ${targetPort}`);

    let usedPort;
    if (!localPort) {
        usedPort = await portFinder.getPortPromise({
            port: 10000
        } as portFinder.PortFinderOptions);
    } else {
        usedPort = localPort;
    }

    kubectl.invokeInTerminal(`port-forward ${podName} ${usedPort}:${targetPort}`);
}