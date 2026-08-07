"use strict";

/**
 * Local multi-node launcher.
 *
 *   node run-nodes.js                       # 3 nodes, 2 of them mining
 *   node run-nodes.js --nodes 5 --miners 3
 *   node run-nodes.js --nodes 3 --fresh     # wipe data dirs first
 *   node run-nodes.js --nodes 3 --no-mine   # nobody mines; drive it yourself
 *
 * Node 0 is the bootstrap peer. Every other node dials it, then discovers the
 * rest through peer gossip -- so this exercises real peer discovery, not a
 * hardcoded mesh.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { parseArgs } = require("./src/node");

const COLORS = ["\x1b[36m", "\x1b[32m", "\x1b[35m", "\x1b[33m", "\x1b[34m", "\x1b[31m"];
const RESET = "\x1b[0m";

function main() {
    const args = parseArgs(process.argv.slice(2));

    const count = Math.max(1, parseInt(args.nodes, 10) || 3);
    const noMine = Boolean(args["no-mine"]);
    const miners = noMine ? 0 : Math.min(count, parseInt(args.miners, 10) || Math.max(1, count - 1));
    const baseApiPort = parseInt(args["base-api-port"], 10) || 8080;
    const baseP2pPort = parseInt(args["base-p2p-port"], 10) || 6001;
    const dataRoot = path.resolve(String(args["data-dir"] || "./data"));
    const persist = !args.ephemeral;

    if (args.fresh && fs.existsSync(dataRoot)) {
        fs.rmSync(dataRoot, { recursive: true, force: true });
        console.log(`wiped ${dataRoot}`);
    }

    const bootstrap = `ws://127.0.0.1:${baseP2pPort}`;
    const children = [];
    let shuttingDown = false;

    console.log("");
    console.log(`Starting ${count} node(s), ${miners} mining.`);
    console.log("");
    console.log("  node   api                      p2p                    mining");
    console.log("  ----   ---                      ---                    ------");
    for (let i = 0; i < count; i++) {
        console.log(
            `  ${String(i).padEnd(6)} http://127.0.0.1:${String(baseApiPort + i).padEnd(8)} ` +
                `ws://127.0.0.1:${String(baseP2pPort + i).padEnd(9)} ${i < miners ? "yes" : "no"}`
        );
    }
    console.log("");
    console.log("Press Ctrl+C to stop all nodes.");
    console.log("");

    for (let i = 0; i < count; i++) {
        const name = `node${i}`;
        const argv = [
            path.join(__dirname, "src", "node.js"),
            "--name", name,
            "--api-port", String(baseApiPort + i),
            "--p2p-port", String(baseP2pPort + i),
            "--advertise-host", "127.0.0.1",
            "--allow-key-gen",
        ];

        // Node 0 has no peers to dial; everyone else bootstraps off it.
        if (i > 0) argv.push("--peers", bootstrap);
        if (i < miners) argv.push("--mine");
        if (persist) argv.push("--data-dir", path.join(dataRoot, name));

        const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
        const color = COLORS[i % COLORS.length];

        const pipe = (stream, isError) => {
            let buffer = "";
            stream.on("data", (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop();
                for (const line of lines) {
                    if (line.trim().length === 0) continue;
                    // Each node already prefixes its own name; colour is enough
                    // to tell them apart at a glance.
                    console.log(`${isError ? "\x1b[31m" : color}${line}${RESET}`);
                }
            });
        };
        pipe(child.stdout, false);
        pipe(child.stderr, true);

        child.on("exit", (code, signal) => {
            if (!shuttingDown) console.log(`${color}${name}${RESET} exited (code ${code}, signal ${signal})`);
        });

        children.push(child);
    }

    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("\nstopping nodes...");
        for (const child of children) {
            // SIGTERM lets each node flush its snapshot; SIGKILL is the backstop.
            try {
                child.kill("SIGTERM");
            } catch {
                /* already gone */
            }
        }
        setTimeout(() => {
            for (const child of children) {
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* already gone */
                }
            }
            process.exit(0);
        }, 2000).unref();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main();
