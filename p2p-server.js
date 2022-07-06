const Websocket = require('ws');

const P2P_PORT = process.env.P2P_PORT || 5001;

const peers = process.env.PEERS ? process.env.PEERS.split(',') : [];
class P2pServer {
    constructor(blockchain) {
        this.blockchain = blockchain;
        this.sockets = [];
    }

    listen() {
        const server = new Websocket.Server({ port: P2P_PORT });
        server.on('connection', socket => this.connectSocket(socket));

        this.connectToPeers();
        console.log(this.sockets)
        console.log(`Listening for peer to peer connections on: ${P2P_PORT}`);
    }
    connectToPeers() {
        peers.forEach(peer => {
            const socket = new Websocket(peer);
            socket.on('open', () => this.connectSocket(socket));

        });
    }
    connectSocket(socket) {
        this.sockets.push(socket);
        console.log('Socket Connected');
        this.messageHandler(socket);
        this.sendChain(socket);
    }
    messageHandler(socket) {
        socket.on('message', message => {
            const data = JSON.parse(message);
            this.blockchain.replaceChain(data);
        });

    }
    sendChain(socket) {
        socket.send(JSON.stringify(this.blockchain.chain));
        console.log(this.sockets)
    }
    syncChains() {
        this.sockets.forEach(socket => this.sendChain(socket));
    }
    broadcastTransaction(transaction) {
        this.sockets.forEach(socket => this.sendTransaction(socket, transaction));
    }

    broadcastClearTransactions() {
        this.sockets.forEach(socket => socket.send(JSON.stringify({
            type: MESSAGE_TYPES.clear_transactions
        })));
    }

}
module.exports = P2pServer;