const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const _ = require('lodash');
const crypto = require('crypto');
const iconv = require('iconv-lite');
const shellEnv = require('shell-env');
const { execSync } = require('child_process');

/**
 * Generates a unique file name compatible with Linux/Unix systems.
 */
const generateLinuxUniqueFileName = (baseDir, prefix = "socket_", extension = ".sock") => {
    const randomId = crypto.randomUUID();
    const fileName = `${prefix}${randomId}${extension}`;
    return path.join(baseDir, fileName);
}

/**
 * Generates a unique IPC communication path depending on the OS.
 */
const generateUniqueFileName = () => {
    if (os.platform() === 'win32') {
        // Use named pipes on Windows
        const randomId = crypto.randomUUID();
        return `\\\\.\\pipe\\myapp-${randomId}`;
    } else {
        // Use file-based sockets on non-Windows systems
        return generateLinuxUniqueFileName(os.tmpdir());
    }
}

// Map of language identifiers to their actual executable command names
const langCommandMap = {
    php: 'php',
    js: 'node',
    py: 'python',
    python: 'python',
    py3: 'python3',
    python3: 'python3',
    bsh: 'bash',
    go: 'go',
    lua: 'lua',
    rb: 'ruby',
    ruby: 'ruby',
    rs: 'rustc',
    rustc: 'rustc',
    bat: 'cmd',
    ps1: 'powershell',
    powershell: 'powershell',
};

const initElectronServer = () => {

    const mainProcessSocketPath = generateUniqueFileName();

    // Store the socket path in the environment variable for external access
    const base64ELECTRON_PIPE = Buffer.from(mainProcessSocketPath, "utf-8").toString("base64");
    _.set(global, 'ELECTRON_PIPE', base64ELECTRON_PIPE);
    _.set(global, 'env.ELECTRON_PIPE', base64ELECTRON_PIPE);
    _.set(process, 'env.ELECTRON_PIPE', base64ELECTRON_PIPE);

    try {
        // Check if the socket file already exists and remove it, if necessary
        if (os.platform() !== "win32") {
            if (fs.existsSync(mainProcessSocketPath)) {
                fs.unlinkSync(mainProcessSocketPath);
            }
        }
    } catch (err) {
        console.warn(`Failed to check or delete existing socket file: ${err.message}`);
    }
    const server = net.createServer((socket) => {
        try {
            socket.setNoDelay(true); // Disable Nagle's algorithm for immediate data transmission
        } catch (err) {
            console.error(`Failed to set no-delay on socket: ${err.message}`);
        }

        socket.on('data', async (stream) => {
            try {
                const { action, data } = JSON.parse(stream.toString());
                switch (action) {
                    case 'execute':
                        // Execute files based on file extension
                        const { file, args = [], option = {} } = data;

                        try {
                            const ext = path.extname(file).slice(1).toLowerCase();
                            const commandLang = _.get(langCommandMap, ext);
                            let command;
                            switch (ext) {
                                case 'php':
                                    command = `${commandLang} -f ${file} ${args.join(' ')}`;
                                    break;
                                case 'js':
                                    command = `${commandLang} ${file} ${args.join(' ')}`;
                                    break;
                                case 'py':
                                    command = `${commandLang} ${file} ${args.join(' ')}`;
                                    break;
                                case 'py3':
                                    command = `${commandLang} ${file} ${args.join(' ')}`;
                                    break;
                                case 'bsh':
                                    command = `${commandLang} ${file} ${args.join(' ')}`;
                                    break;
                                case 'go':
                                    command = `${commandLang} run ${file} ${args.join(' ')}`;
                                    break;
                                case 'sh':
                                    command = `${commandLang} ${file} ${args.join(' ')}`;
                                    break;
                                case 'rb':
                                case 'ruby':
                                    command = `${commandLang} ${file} ${args.join(' ')}`;
                                    break;
                                case 'lua':
                                    command = `${commandLang} ${file} ${args.join(' ')}`;
                                    break;
                                case 'rs':
                                    const executable = file.replace(/\.rs$/, '');
                                    command = `${commandLang} ${file} && ./${executable} ${args.join(' ')}`;
                                    break;
                                case 'bat':
                                    command = `${file} ${args.join(' ')}`;
                                    break;
                                case 'ps1':
                                    command = `${commandLang} -File ${file} ${args.join(' ')}`;
                                    break;
                                default:
                                    throw new Error(`Unsupported file extension: ${ext}`);
                            }

                            const isWindows = process.platform === 'win32';
                            const parseBuffer = isWindows && ext != 'js';

                            const env = await shellEnv();
                            const execOptions = _.assign(parseBuffer ? {} : { encoding: 'utf8' }, {
                                ...option, env: {
                                    ...process.env, PATH: env.PATH
                                }
                            });
                            let output = '';
                            const buffer = execSync(command, execOptions);
                            try {
                                output = parseBuffer
                                    ? iconv.decode(buffer, 'cp936') // GBK code page for Windows
                                    : buffer.toString('utf8');
                            } catch (err) {
                                const errorBuffer = parseBuffer
                                    ? iconv.encode(JSON.stringify(err), 'cp936')
                                    : Buffer.from(JSON.stringify(err), 'utf8');

                                output = parseBuffer
                                    ? iconv.decode(errorBuffer, 'cp936')
                                    : errorBuffer.toString('utf8');
                            }

                            let result = output;
                            try {
                                result = JSON.stringify(JSON.parse(result));
                            } catch (e) { }

                            socket.write(JSON.stringify({ status: 'success', result }) + "\n\n");
                        } catch (executionError) {
                            socket.write(JSON.stringify({ status: 'error', message: executionError.message }) + "\n\n");
                        }
                        break;
                }
            } catch (parsingError) {
                socket.write(JSON.stringify({ error: `Failed to parse request: ${parsingError.message}` }) + "\n\n");
            }
        });
    });

    server.listen(mainProcessSocketPath, () => {
        console.log(`Server is up and running. Listening on: ${mainProcessSocketPath}`);
    }).on('error', (err) => {
        console.error(`Server error: ${err.message}`);
    });
};
module.exports = { initElectronServer };
