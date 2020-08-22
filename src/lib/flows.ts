import * as fs from 'fs';
import * as jsonDiff from 'json-diff';
import { Spinner }  from 'cli-spinner';
import * as chalk from 'chalk';

import { checkTask } from '../utils/checks';

import { addToProgressBar } from '../utils/progressBar';
import CONFIG from '../utils/config';
import CognigyClient from '../utils/cognigyClient';
import { removeCreateDir } from '../utils/checks';
import { pullLocales } from './locales';

// Interfaces
import { ILocaleIndexItem_2_0 } from '@cognigy/rest-api-client/build/shared/interfaces/restAPI/resources/locales/v2.0';
import { IIntent } from '@cognigy/rest-api-client/build/shared/interfaces/resources/intent/IIntent';
import { ISentence_2_0 } from '@cognigy/rest-api-client/build/shared/interfaces/restAPI/resources/flow/v2.0/sentence/ISentence_2_0';

/**
 * Clones Cognigy Flows to disk
 * @param availableProgress How much of the progress bar can be filled by this process
 */
export const cloneFlows = async (availableProgress: number): Promise<void> => {
    // The base directory for Flows
    const flowDir = CONFIG.agentDir + "/flows";
    await removeCreateDir(flowDir);

    // query Cognigy.AI for all Flows in this agent
    const flows = await CognigyClient.indexFlows({
        "projectId": CONFIG.agent
    });

    const progressPerFlow = availableProgress / flows.items.length;

    // create a sub-folder, chart.json and config.json for each Flow
    for (let flow of flows.items) {
        await pullFlow(flow.name, progressPerFlow);
    }

    return Promise.resolve();
};


/**
 * Pulls a Flow from Cognigy.AI to disk
 * @param flowName The name of the Flow to pull
 * @param availableProgress How much of the progress bar can be filled by this process
 */
export const pullFlow = async (flowName: string, availableProgress: number): Promise<void> => {
    // The base directory for Flows
    const flowsDir = CONFIG.agentDir + "/flows";
    const flowDir = flowsDir + "/" + flowName;

    await removeCreateDir(flowDir);

    // query Cognigy.AI for all Flows in this agent
    const flows = await CognigyClient.indexFlows({
        "projectId": CONFIG.agent
    });

    // check if flow with given name exists
    const flow = flows.items.find((flow) => {
        if (flow.name === flowName)
            return flow;
    });

    if (!flow) {
        console.log(`\n\nFlow with name ${flowName} can't be found on Cognigy.AI. Aborting...`);
        process.exit(0);
    }

    const locales = await pullLocales();

    const progressPerLocale = availableProgress / locales.items.length;

    for (let locale of locales.items) {
        const localeDir = flowDir + "/" + locale.name;

        await removeCreateDir(localeDir);

        fs.writeFileSync(flowDir + "/config.json", JSON.stringify(flow, undefined, 4));

        const chart = await CognigyClient.readChart({
            "resourceId": flow._id,
            "resourceType": "flow",
            "preferredLocaleId": locale._id
        });

        // half of the available progress bar space is allocated to Nodes, the other half to intents
        const progressPerNode = progressPerLocale / 2 / chart.nodes.length;

        // iterate through all Nodes for this chart and add the information into the chart
        for (let node of chart.nodes) {
            const Node = await CognigyClient.readChartNode({
                "nodeId": node._id,
                "resourceId": flow._id,
                "resourceType": "flow",
                "preferredLocaleId": locale._id
            });
            node["config"] = Node.config;
            addToProgressBar(progressPerNode);
        }

        fs.writeFileSync(localeDir + "/chart.json", JSON.stringify(chart, undefined, 4));

        const flowIntents = await CognigyClient.indexIntents({
            flowId: flow._id,
            preferredLocaleId: locale._id
        });

        const intents = await pullIntents(flow, flowIntents, locale, progressPerLocale);

        fs.writeFileSync(localeDir + "/intents.json", JSON.stringify(intents, undefined, 4));
    }

    return Promise.resolve();
};

/**
 * Restores Flows back to Cognigy.AI
 * @param availableProgress How much of the progress bar can be filled by this process
 */
export const restoreFlows = async (availableProgress: number): Promise<void> => {
    const agentFlowDir = CONFIG.agentDir + "/flows";

    // Read Flow directory
    const flowDirectories = fs.readdirSync(agentFlowDir);
    if (!flowDirectories || flowDirectories.length === 0) {
        console.log("No Flows found, aborting...\n");
        return;
    }

    const progressPerFlow = availableProgress / flowDirectories.length;

    // Go through all Flows and try to push them to Cognigy.AI
    for (let flow of flowDirectories) {
        await pushFlow(flow, progressPerFlow);
    }
    return Promise.resolve();
};

/**
 * Pushes a Flow back to Cognigy.AI
 * @param flowName The name of the Flow to push
 * @param availableProgress How much of the progress bar can be filled by this process
 */
export const pushFlow = async (flowName: string, availableProgress: number): Promise<void> => {
    const flowsDir = CONFIG.agentDir + "/flows";
    const flowDir = flowsDir + "/" + flowName;

    if (fs.existsSync(flowDir + "/config.json") && fs.existsSync(flowsDir + "/locales.json")) {
        const locales = JSON.parse(fs.readFileSync(flowsDir + "/locales.json").toString());

        for (let locale of locales) {
            // chart and config exist for this flow, proceed
            try {
                const flowConfig = JSON.parse(fs.readFileSync(flowDir + "/config.json").toString()),
                      flowChart = JSON.parse(fs.readFileSync(flowDir + "/" + locale.name + "/chart.json").toString()),
                      flowIntents: IIntent[] = JSON.parse(fs.readFileSync(flowDir + "/" + locale.name + "/intents.json").toString());

                const flowId = flowConfig._id;

                try {
                    await CognigyClient.updateFlow({
                        "flowId": flowId,
                        "name": flowConfig.name,
                        "localeId": locale._id
                    });
                } catch (err) {
                    console.error(`Error when updating Flow ${flowName} on Cognigy.AI: ${err.message}.\nAborting...`);
                    process.exit(0);
                }

                const progressPerNode = availableProgress / 2 / locales.length / flowChart.nodes.length;

                for (let node of flowChart.nodes) {
                    const { _id: nodeId, comment, config, isDisabled, isEntryPoint, label, localeReference } = node;
                    if (localeReference === locale._id) {
                        try {
                            await CognigyClient.updateChartNode({
                                resourceId: flowId,
                                resourceType: "flow",
                                nodeId,
                                comment,
                                config,
                                isDisabled,
                                isEntryPoint,
                                label,
                                localeId: localeReference
                            });
                        } catch (err) {
                            // console.log(`\nError when updating Chart Node ${nodeId} in Flow ${flowName} - ${err.message}`);
                            // process.exit(0);
                        }
                    }
                    addToProgressBar(progressPerNode);
                }

                if (flowIntents.length > 0) {
                    const progressPerIntent = availableProgress / 2 / locales.length / flowIntents.length;
                    for (let intent of flowIntents) {
                        try {
                            const {
                                _id: intentId,
                                tags,
                                name,
                                isDisabled,
                                confirmationSentences,
                                condition,
                                rules,
                                childFeatures,
                                localeReference
                            } = intent;

                            if (localeReference === locale._id) {
                                const sentences: ISentence_2_0[] = intent["sentences"];

                                await CognigyClient.updateIntent({
                                    intentId,
                                    tags,
                                    name,
                                    isDisabled,
                                    confirmationSentences,
                                    condition,
                                    rules,
                                    childFeatures,
                                    flowId,
                                    localeId: locale._id
                                });

                                for (let sentence of sentences) {
                                    await CognigyClient.updateSentence({
                                        flowId,
                                        intentId,
                                        localeReference: locale._id,
                                        sentenceId: sentence._id,
                                        slots: sentence.slots,
                                        text: sentence.text
                                    });
                                }
                            }
                        } catch (err) {}

                        addToProgressBar(progressPerIntent);
                    }
                } else addToProgressBar(availableProgress / 2);

            } catch (err) {
                console.log(err.message);
            }
        }
    } else {
        // chart or config are missing, skip
        addToProgressBar(availableProgress);
    }
    return Promise.resolve();
};

/**
 * Compares two Flow JSON representations
 * @param flowName ID of the Flow to compare
 * @param mode full or node
 */
export const diffFlows = async (flowName: string, mode: string = 'full'): Promise<void> => {
    // check if a valid mode was selected
    if (['full', 'node'].indexOf(mode) === -1) {
        console.log(`Selected mode not supported. Supported modes:\n\n- full\n- node\n`);
        return;
    }

    const spinner = new Spinner(`Comparing ${chalk.green('local')} and ${chalk.red('remote')} Flow resource ${chalk.blueBright(flowName)}... %s`);
    spinner.setSpinnerString('|/-\\');
    spinner.start();

    const flowsDir = CONFIG.agentDir + "/flows";
    const flowDir = flowsDir + "/" + flowName;
    const localesFile = flowsDir + "/locales.json";

    if (!fs.existsSync(localesFile)) {
        spinner.stop();
        console.error(`\n\nMissing locales.json. Execute 'cognigy pull locales' to updates locales.`);
        return;
    }

    const locales: ILocaleIndexItem_2_0[] = JSON.parse(fs.readFileSync(flowsDir + "/locales.json").toString());

    for (let locale of locales) {
        // check whether Flow directory and chart.json for the Flow exist
        if (!fs.existsSync(flowDir) || !fs.existsSync(flowDir + "/" + locale.name + "/chart.json") || !fs.existsSync(flowDir + "/config.json")) {
            spinner.stop();
            console.error(`\nThe requested Flow (${chalk.blueBright(flowName)}) in locale ${chalk.yellow(locale.name)} couldn't be found locally or doesn't contain a valid config.json and chart.json`);
            return;
        }

        // retrieve local Flow chart
        const localChart = JSON.parse(fs.readFileSync(flowsDir + "/" + flowName + "/" + locale.name + "/chart.json").toString()),
            localConfig = JSON.parse(fs.readFileSync(flowsDir + "/" + flowName + "/config.json").toString());

        try {
            // retrieve remote Flow chart
            const remoteChart = await CognigyClient.readChart({
                "resourceId": localConfig._id,
                "resourceType": "flow",
                "preferredLocaleId": locale._id
            });

            // retrieve configuration for all Flow Chart Nodes and combine them into the chart
            for (let node of remoteChart.nodes) {
                const Node = await CognigyClient.readChartNode({
                    "nodeId": node._id,
                    "resourceId": localConfig._id,
                    "resourceType": "flow",
                    "preferredLocaleId": locale._id
                });
                node["config"] = Node.config;
            }

            // comparing Flows
            if (mode === "node") {
                // perform node-level comparison
                const localNodes: Map<string, any> = new Map();
                localChart.nodes.forEach((node) => {
                    localNodes.set(node._id.toString(), node);
                });

                const remoteNodes: Map<string, any> = new Map();
                remoteChart.nodes.forEach((node) => {
                    remoteNodes.set(node._id.toString(), node);
                });

                console.log("\n");

                let copiesAreDifferent = false;
                let differences = "";

                // compare all local Nodes to remote Nodes
                localNodes.forEach((localNode, nodeId) => {
                    const remoteNode = remoteNodes.get(nodeId);
                    if (remoteNode) {
                        const diffString = jsonDiff.diffString(remoteNode, localNode);
                        if (diffString) {
                            differences += `Node ${nodeId} (called ${localNode.label} on ${chalk.green('local')}) differs on ${chalk.red('remote')}/${chalk.green('local')}. ${diffString}`;
                            copiesAreDifferent = true;
                        }
                    }
                });

                // check which nodes exist on local that are missing on remote
                localNodes.forEach((localNode, nodeId) => {
                    const remoteNode = remoteNodes.get(nodeId);
                    if (!remoteNode) {
                        differences += `Node ${nodeId} (${localNode.label}) only exists on ${chalk.green('local')}.`;
                        differences += chalk.green(JSON.stringify(localNode, undefined, 4));
                        copiesAreDifferent = true;
                    }
                });

                // check which nodes exist only on remote and are missing on local
                remoteNodes.forEach((remoteNode, nodeId) => {
                    const localNode = localNodes.get(nodeId);
                    if (!localNode) {
                        differences += `Node ${nodeId} (${remoteNode.label}) only exists on ${chalk.red('remote')}.`;
                        differences += chalk.red(JSON.stringify(remoteNode, undefined, 4));
                        copiesAreDifferent = true;
                    }
                });

                // show results
                if (copiesAreDifferent) {
                    console.log(`The Flow ${chalk.blueBright(flowName)} in locale ${chalk.yellow(locale.name)} DIFFERS on ${chalk.green('local')} and ${chalk.red('remote')}.`);
                    console.log(differences);
                } else console.log(`The Flow ${chalk.blueBright(flowName)} in locale ${chalk.yellow(locale.name)} is identical on ${chalk.green('local')} and ${chalk.red('remote')}.`);
            } else {
                // perform full comparison and output results
                const diffString = jsonDiff.diffString(remoteChart, localChart);

                if (diffString) {
                    console.log(`The Flow ${chalk.blueBright(flowName)} in locale ${chalk.yellow(locale.name)} DIFFERS on ${chalk.green('local')} and ${chalk.red('remote')}.`);
                    console.log(`\n${diffString}`);
                } else console.log(`The Flow ${chalk.blueBright(flowName)} in locale ${chalk.yellow(locale.name)} is identical on ${chalk.green('local')} and ${chalk.red('remote')}.`);
            }
        } catch (err) {
            spinner.stop();
            console.error(err.message);
        }
    }
    spinner.stop();
};

/**
 * Trains a Flow
 * @param flowName The name of the Flow
 */
export const trainFlow = async (flowName: string, timeout: number = 10000): Promise<void> => {
    const flowsDir = CONFIG.agentDir + "/flows";
    const flowDir = flowsDir + "/" + flowName;

    const flowConfig = JSON.parse(fs.readFileSync(flowDir + "/config.json").toString());
    const locales = await pullLocales();

    for (let locale of locales.items) {
        const spinner = new Spinner(`Training intents for locale ${chalk.yellow(locale.name)} ... %s`);
        spinner.setSpinnerString('|/-\\');
        spinner.start();

        const result = await CognigyClient.trainIntents({
            flowId: flowConfig._id,
            localeId: locale._id
        });

        try {
            await checkTask(result._id, 0, timeout);
            console.log(`\n[${chalk.green("success")}] Intents trained for locale ${chalk.yellow(locale.name)}`);
        } catch (err) {
            console.log(`\n[${chalk.red("error")}] Intents in ${chalk.yellow(locale)} couldn't be trained within timeout period (${5 * timeout} ms)`);
        }
        spinner.stop();
    }
};

/**
 * Pull Intents recursively
 * @param flow Which flow to pull from
 * @param flowIntents Current level of intents
 * @param locale Locale to pull from
 * @param availableProgress How much progress is left on the progress bar
 * @param intents Intents found
 */
const pullIntents = async (flow, flowIntents, locale, availableProgress, intents = []) => {
    if (flowIntents && flowIntents.items && flowIntents.items && flowIntents.items.length > 0) {
        const progressPerIntent = availableProgress / 2 / flowIntents.items.length;
        for (let intent of flowIntents.items) {
            const intentData = await CognigyClient.readIntent({
                intentId: intent._id,
                flowId: flow._id,
                preferredLocaleId: locale._id
            });

            // find child intents
            const childIntents = await CognigyClient.indexIntents({
                flowId: flow._id,
                preferredLocaleId: locale._id,
                parent: intent._id
            });

            if (childIntents && childIntents.items && childIntents.items.length > 0)
                await pullIntents(flow, childIntents, locale, 0, intents);

            const flowIntentSentences = await CognigyClient.indexSentences({
                flowId: flow._id,
                intentId: intent._id,
                preferredLocaleId: locale._id
            });

            const intentSentences = [];
            if (flowIntentSentences && flowIntentSentences.items && flowIntentSentences.items.length > 0) {
                for (let sentence of flowIntentSentences.items) {
                    const sentenceData = await CognigyClient.readSentence({
                        flowId: flow._id,
                        intentId: intent._id,
                        sentenceId: sentence._id
                    });

                    intentSentences.push(sentenceData);
                }
            }
            intents.push({
                ...intentData,
                sentences: intentSentences
            });
            addToProgressBar(progressPerIntent); // half the value as other half was other intents
        }
    }
    return intents;
};

