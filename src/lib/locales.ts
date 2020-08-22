import * as fs from 'fs';

import CONFIG from '../utils/config';
import CognigyClient from '../utils/cognigyClient';

/**
 * Updates locales definitons from server (every x seconds)
 * @param cacheTime Seconds to cache locales
 */ 
export const pullLocales = async (cacheTime: number = 10) => {
    const localesLocation = CONFIG.agentDir + "/flows/locales.json";

    let localesAge = cacheTime + 1;
    let locales = null;

    /* Check if locales.json exists */
    if (fs.existsSync(localesLocation)) {
        const stats = fs.statSync(localesLocation);
        const mtime = stats.mtime;
        localesAge = (new Date().getTime() - mtime.getTime()) / 1000;
    }

    /* If locales are stale, update them from server */
    if (localesAge > cacheTime) {
        locales = await CognigyClient.indexLocales({
            projectId: CONFIG.agent
        });

        fs.writeFileSync(localesLocation, JSON.stringify(locales.items, undefined, 4));
    } else {
        locales = JSON.parse(fs.readFileSync(localesLocation).toString());
    }

    return locales;
};
