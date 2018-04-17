'use strict';

import {host} from '../../host';
import * as cli from '../../shell';
import * as yamljs from 'yamljs';
import { create as kubectlCreate, Kubectl } from '../../kubectl';
import { fs } from '../../fs';
import { shell } from '../../shell';
import { pickChart } from '../../helm.exec';
import * as clipboardy from 'clipboardy';

interface ServiceInstance {
    name: string;
    namespace: string;
    class: string;
    plan: string;
    status: string;
}

interface ServiceInstanceMap {
    [name: string] : ServiceInstance;
}

const kubectl = kubectlCreate(host, fs, shell);

export const ServiceInstanceNames : string[] = [];
export const ServiceInstanceArray : ServiceInstance[] = [];
export const ServiceInstanceMap : ServiceInstanceMap = {};

async function pickChartAsync (): Promise<any> {
    return new Promise((resolve, reject) => {
        pickChart((chartPath) => {
            resolve(chartPath);
        });
    });
}

/**
 * Creates a binding for the application to the selected service.
 * Modifies the values.yaml file to retain information about available environment variables.
 * Drops an information blurb on the clipboard for service catalog usage information.
 */
export async function createBinding () {
    if (ServiceInstanceNames.length === 0 && Object.keys(ServiceInstanceMap).length === 0) {
        let serviceInstances = await getServiceInstances();
    }

    const serviceToBind = await host.showQuickPick(ServiceInstanceNames, {
        placeHolder: "Pick an External Service to add to the selected application",
    });

    const binding = await createServiceBinding(serviceToBind);
    const secretData = await getSecretData(binding);
    const secretKeys = Object.keys(secretData);
    const chartPath = await pickChartAsync();
    await writeSecretData(chartPath, binding, secretKeys);
    await writeUsageToClipboard(binding, secretKeys);

    // TODO: add the binding secret as environment variables in deployment.yaml.
    host.showInformationMessage(`Bound the application to External Service "${serviceToBind}"`);
}

/**
 * Retrieves deployed secrets.
 * @param secretName The secret name deployed by service catalog.
 * @returns The secret data
 */
async function getSecretData (secretName): Promise<Object> {
    let secretResults;
    try {
        secretResults = await kubectl.invokeAsync(`get secret ${secretName} -o json`);
    } catch (e) {
        host.showErrorMessage(`Could not find the External Service secret ${secretName} on the cluster`);
        return;
    }

    if (secretResults.code !== 0) {
        host.showErrorMessage(`Could not get External Service ${secretName} on the cluster`);
        return;
    }

    const secretResultsJson = JSON.parse(secretResults.stdout);
    return secretResultsJson.data;
}

/**
 * Writes the secret keys (not the values) to the values.yaml.
 * @param chartPath the absolute path to the chart needing to be modified
 * @param bindingName the name of the binding/service
 * @param secretKeys array containing keys in the deployed secret.
 */
async function writeSecretData (chartPath, bindingName: string, secretKeys: string[]) {
    const valuesFile = `${chartPath}/values.yaml`;
    const valuesYaml = yamljs.load(valuesFile);

    // if we have service catalog keys already, add them.
    if (valuesYaml.serviceCatalogEnv) {
        valuesYaml.serviceCatalogEnv.push({
            name: bindingName,
            vars: secretKeys
        });
    } else {
        valuesYaml.serviceCatalogEnv = [
            {
                name: bindingName,
                vars: secretKeys
            }
        ];
    }

    // remove the file, and re-write our modified version.
    await fs.unlinkAsync(valuesFile);
    await fs.writeFile(valuesFile, yamljs.stringify(valuesYaml, 2));
}

/**
 * Writes usage information for the deployed service to the system clipboard.
 * @param bindingName The name of the external service
 * @param secretKeys The keys to write usage information about.
 */
async function writeUsageToClipboard (bindingName:string, secretKeys:string[]) {
    host.showInformationMessage("Wrote Service Usage information to your clipboard.");

    const environmentVariableMessages:string[] = [];

    for (const variableName of secretKeys) {
        const envVar = `${bindingName}_${variableName}`.toUpperCase();
        environmentVariableMessages.push(
            `// ${envVar}`
        );
    }

    const message = `// To use service ${bindingName}, we added a number of environment variables\n// to your application, as listed below:\n${environmentVariableMessages.join('\n')}`;

    await clipboardy.write(message);
}

/**
 * Binds an external service by creating a secret containing consumable binding information.
 * @param serviceName The service to create a binding for.
 */
async function createServiceBinding (serviceName: string): Promise<string> {
    let results;
    try {
        results = await cli.shell.execCore(`svcat bind ${serviceName}`, '');
    } catch (e) {
        host.showErrorMessage(`Error binding to External Service "${serviceName}"`);
        return;
    }

    if (results.code !== 0) {
        host.showErrorMessage(`Could not bind to External Service "${serviceName}"`);
        return;
    }

    return serviceName;
}

/**
 * Gets available service instances deployed to your cluster.
 * @returns A list of ServiceInstance objects.
 */
export async function getServiceInstances (): Promise<ServiceInstance[]> {
    // If we've already got service instances, just return those.
    // TODO: figure out how we're gonna add new instances as they come up.
    if (ServiceInstanceNames.length !== 0 && Object.keys(ServiceInstanceMap).length !== 0) {
        return ServiceInstanceArray;
    }

    let results;
    try {
        results = await cli.shell.execCore(`svcat get instances`, '');
    } catch (e) {
        host.showErrorMessage(`Error retrieving Service Instances`);
        return;
    }

    if (results.code !== 0) {
        host.showErrorMessage(`Error retrieving Service Instances`);
        return;
    }

    return cleanUpInstanceResults(results.stdout as string);
}

function cleanUpInstanceResults (results:string): ServiceInstance[] {
    // Remove headers + empty lines.
    const splitResults = results.split('\n').slice(2).filter((s) => s.length != 0);
    const cleanedResults:ServiceInstance[] = [];

    // Build up ServiceInstance objects.
    for (let line of splitResults) {
        const filtered = line.split(' ').filter((s) => s.length != 0);
        const serviceInstance: ServiceInstance = {
            name: filtered[0],
            namespace: filtered[1],
            class: filtered[2],
            plan: filtered[3],
            status: filtered[4]
        };

        // Service instance name -> service instance map.
        ServiceInstanceMap[serviceInstance.name] = serviceInstance;

        // All available service instance names.
        ServiceInstanceNames.push(serviceInstance.name);

        ServiceInstanceArray.push(serviceInstance);
        cleanedResults.push(serviceInstance);
    }

    return cleanedResults;
}