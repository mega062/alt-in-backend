/// <reference types="node" />
/// <reference types="node" />
import { LaunchOptions, Browser, Page } from "puppeteer-core";
import { Transform } from "stream";
import WebSocket from "ws";
import { IncomingMessage } from "http";
type StreamLaunchOptions = LaunchOptions & {
    allowIncognito?: boolean;
} & {
    closeDelay?: number;
} & {
    extensionPath?: string;
};
export declare const wss: Promise<WebSocket.Server<typeof WebSocket, typeof IncomingMessage>>;
export declare function launch(arg1: StreamLaunchOptions | {
    launch?: Function;
    [key: string]: any;
}, opts?: StreamLaunchOptions): Promise<Browser>;
export type BrowserMimeType = "video/webm" | "video/webm;codecs=vp8" | "video/webm;codecs=vp9" | "video/webm;codecs=vp8.0" | "video/webm;codecs=vp9.0" | "video/webm;codecs=vp8,opus" | "video/webm;codecs=vp8,pcm" | "video/WEBM;codecs=VP8,OPUS" | "video/webm;codecs=vp9,opus" | "video/webm;codecs=vp8,vp9,opus" | "audio/webm" | "audio/webm;codecs=opus" | "audio/webm;codecs=pcm" | "video/mp4" | "video/mp4;codecs=avc1,mp4a.40.2" | "video/mp4;codecs=vp9,mp4a.40.2" | "video/mp4;codecs=av01,mp4a.40.2";
export type Constraints = {
    mandatory?: MediaTrackConstraints;
    optional?: MediaTrackConstraints;
};
interface TabQueryOptions {
    active?: boolean;
    audible?: boolean;
    autoDiscardable?: boolean;
    currentWindow?: boolean;
    discarded?: boolean;
    groupId?: number;
    highlighted?: boolean;
    index?: number;
    lastFocusedWindow?: boolean;
    muted?: boolean;
    pinned?: boolean;
    status?: TabStatus;
    title?: string;
    url?: string | string[];
    windowId?: number;
    windowType?: WindowType;
}
type TabStatus = "unloaded" | "loading" | "complete";
type WindowType = "normal" | "popup" | "panel" | "app" | "devtools";
export interface getStreamOptions {
    audio: boolean;
    video: boolean;
    videoConstraints?: Constraints;
    audioConstraints?: Constraints;
    mimeType?: BrowserMimeType;
    audioBitsPerSecond?: number;
    videoBitsPerSecond?: number;
    bitsPerSecond?: number;
    frameSize?: number;
    delay?: number;
    /**
     * Tab query options to target the correct tab,
     * see [Chrome's extensions documentation](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-query) for more info.
     */
    tabQuery?: TabQueryOptions;
    retry?: {
        each?: number;
        times?: number;
    };
    streamConfig?: {
        highWaterMarkMB?: number;
        immediateResume?: boolean;
        closeTimeout?: number;
    };
}
export declare function getExtensionPage(browser: Browser): Promise<Page>;
export declare function getStream(page: Page, opts: getStreamOptions): Promise<Transform>;
export {};
