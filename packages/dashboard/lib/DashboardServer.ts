import express, { Application, NextFunction, Request, Response } from "express";
import WebSocket from "isomorphic-ws";
import path from "path";
import getPort from "get-port";
import open from "open";
import {
  base64ToJson,
  connectToMessageBusWithRetries,
  createMessage,
  DashboardMessageBus,
  LogMessage,
  sendAndAwait,
  jsonToBase64,
  isInitializeMessage
} from "@truffle/dashboard-message-bus";
import cors from "cors";
import type { Server } from "http";
import debugModule from "debug";

/**
 * Public ethereum chains that can be added to a wallet and switched via the
 * dashboard's network manager. Currently based off of https://docs.metamask.io/guide/rpc-api.html#unrestricted-methods
 */
export interface DashboardChain {
  chainId: string;
  chainName: string;
  nativeCurrency: {
    name?: string;
    symbol: string;
    decimals: number;
  };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
  iconUrls?: string[];
  isLocalChain?: boolean;
}

export interface DashboardServerOptions {
  /** Port of the dashboard */
  port: number;

  /** Host of the dashboard (default: localhost) */
  host?: string;

  /** Boolean indicating whether debug output should be logged (default: false) */
  verbose?: boolean;

  /** Boolean indicating whether whether starting the DashboardServer should automatically open the dashboard (default: true) */
  autoOpen?: boolean;

  /** Chain array used to populate the list of public chains to display in the dashboard network manager. */
  dashboardChains: DashboardChain[];
}

export class DashboardServer {
  port: number;
  host: string;
  verbose: boolean;
  autoOpen: boolean;
  frontendPath: string;
  dashboardChains: DashboardChain[];

  private expressApp?: Application;
  private httpServer?: Server;
  private messageBus?: DashboardMessageBus;
  private publishSocket?: WebSocket;
  private subscribeSocket: WebSocket;

  boundTerminateListener: () => void;

  constructor(options: DashboardServerOptions) {
    this.port = options.port;
    this.host = options.host ?? "localhost";
    this.verbose = options.verbose ?? false;
    this.autoOpen = options.autoOpen ?? true;
    this.frontendPath = path.join(
      __dirname,
      ".",
      "dashboard-frontend",
      "build"
    );
    this.dashboardChains = options.dashboardChains;

    this.boundTerminateListener = () => this.stop();
  }

  async start() {
    if (this.httpServer?.listening) return;

    this.messageBus = await this.startMessageBus();

    this.expressApp = express();

    this.expressApp.use(cors());
    this.expressApp.use(express.json());
    this.expressApp.use(express.static(this.frontendPath));

    this.expressApp.get("/ports", this.getPorts.bind(this));

    this.subscribeSocket = await this.connectToSubscribePort();

    this.publishSocket = await this.connectToPublishPort();

    this.expressApp.post("/rpc", this.postRpc.bind(this));

    await new Promise<void>(resolve => {
      this.httpServer = this.expressApp!.listen(this.port, this.host, () => {
        if (this.autoOpen) {
          const host = this.host === "0.0.0.0" ? "localhost" : this.host;
          open(`http://${host}:${this.port}`);
        }
        resolve();
      });
    });
  }

  async stop() {
    this.messageBus?.off("terminate", this.boundTerminateListener);
    await this.messageBus?.terminate();
    this.publishSocket?.terminate();
    this.subscribeSocket.terminate();
    return new Promise<void>(resolve => {
      this.httpServer?.close(() => resolve());
    });
  }

  private getPorts(req: Request, res: Response) {
    if (!this.messageBus) {
      throw new Error("Message bus has not been started yet");
    }

    res.json({
      dashboardPort: this.port,
      subscribePort: this.messageBus.subscribePort,
      publishPort: this.messageBus.publishPort
    });
  }

  private postRpc(req: Request, res: Response, next: NextFunction) {
    if (!this.publishSocket) {
      throw new Error("Not connected to message bus");
    }

    const message = createMessage("provider", req.body);
    sendAndAwait(this.publishSocket, message)
      .then(response => res.json(response.payload))
      .catch(next);
  }

  private async startMessageBus() {
    const messageBusPublishPort = await getPort({ host: this.host });
    const messageBusSubscribePort = await getPort({ host: this.host });
    const messageBus = new DashboardMessageBus(
      messageBusPublishPort,
      messageBusSubscribePort,
      this.host
    );

    await messageBus.start();
    messageBus.on("terminate", this.boundTerminateListener);

    return messageBus;
  }

  private async connectToPublishPort() {
    if (!this.messageBus) {
      throw new Error("Message bus has not been started yet");
    }

    const socket = await connectToMessageBusWithRetries(
      this.messageBus.publishPort,
      this.host
    );

    if (this.verbose) {
      socket.addEventListener("message", (event: WebSocket.MessageEvent) => {
        if (typeof event.data !== "string") {
          event.data = event.data.toString();
        }

        const message = base64ToJson(event.data);
        if (message.type === "log") {
          const logMessage = message as LogMessage;
          const debug = debugModule(logMessage.payload.namespace);
          debug.enabled = true;
          debug(logMessage.payload.message);
        }
      });
    }

    return socket;
  }

  private async connectToSubscribePort() {
    if (!this.messageBus) {
      throw new Error("Message bus has not been started yet");
    }

    const socket = await connectToMessageBusWithRetries(
      this.messageBus.subscribePort,
      this.host
    );

    socket.addEventListener("message", (event: WebSocket.MessageEvent) => {
      if (typeof event.data !== "string") {
        event.data = event.data.toString();
      }

      const message = base64ToJson(event.data);
      if (isInitializeMessage(message)) {
        const responseMessage = {
          id: message.id,
          payload: { dashboardChains: this.dashboardChains }
        };
        socket.send(jsonToBase64(responseMessage));
      }
    });
    socket.send("ready");
    return socket;
  }
}
