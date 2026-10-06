const path = require("path")
const fs = require("fs");

const nodeModules = {};
fs.readdirSync('./node_modules')
    .filter((x) => {
        return ['.bin'].indexOf(x) === -1;
    })
    .forEach((mod) => {
        if (mod.startsWith('@')) {
            // scoped packages live one directory deeper (e.g. @serialport/parser-readline)
            fs.readdirSync(path.join('./node_modules', mod)).forEach((scopedMod) => {
                const name = `${mod}/${scopedMod}`;
                nodeModules[name] = 'commonjs ' + name;
            });
        } else {
            nodeModules[mod] = 'commonjs ' + mod;
        }
    });

module.exports = {
    // devtool: 'source-map',
    entry: './src/index.js',
    target: 'node',
    node: {
        __dirname: false,
        __filename: false,
    },
    output: {
        path: path.resolve(__dirname, "build-server"),
        filename: "startLocalServer.js",
        libraryTarget: "commonjs"
    },
    externals: nodeModules
};
