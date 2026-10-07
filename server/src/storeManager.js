import fs from 'fs';
import path from 'path';
import isElectron from 'is-electron';
import electron from 'electron';

class StoreManager {
    constructor() {
        //user data
        this.dir_user_data = null;
        this.dir_code_projects_my = null;

        //software data: 随着软件更新而全部改变
        this.dir_code_projects_example = path.join(__dirname, '..', 'static', 'code', 'example_projects');;
        this.path_p3d_cura_engine = null;

        if (isElectron()) {
            // Preload scripts (where this module actually runs under Electron)
            // never had direct access to the main process's `app` object, and
            // Electron removed the old built-in `remote` module in v14+. The
            // userData path is passed down via an env var set by main.js
            // before the window/preload is created; `electron.app` is kept as
            // a fallback for the (currently unused) case of this module being
            // required directly from the main process.
            this.dir_user_data = process.env.ELECTRON_USER_DATA_DIR
                || (electron.app && electron.app.getPath('userData'));
        } else {
            this.dir_user_data = path.join(__dirname, '..', 'static');
        }

        const curaEngineBasePath = path.join(__dirname, '..', 'CuraEngine', '4.6.2');
        switch (process.platform) {
            case 'darwin':
                this.path_p3d_cura_engine = path.join(curaEngineBasePath, 'macOS', 'CuraEngine');
                break;
            case 'win32':
                this.path_p3d_cura_engine = path.join(curaEngineBasePath, 'Win-x64', 'CuraEngine.exe');
                break;
            case 'linux':
                this.path_p3d_cura_engine = path.join(curaEngineBasePath, 'Linux-x64', 'CuraEngine');
                break;
        }

        this.dir_code_projects_my = path.join(this.dir_user_data, 'code', 'my_projects');

        fs.mkdirSync(this.dir_code_projects_my, {recursive: true});
        fs.mkdirSync(this.dir_code_projects_example, {recursive: true});
    }
}

const storeManager = new StoreManager();

export default storeManager;
