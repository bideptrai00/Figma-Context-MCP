import fs from "fs";
import { parseFigmaResponse, SimplifiedDesign } from "./simplify-node-response.js";
import type {
  GetImagesResponse,
  GetFileResponse,
  GetFileNodesResponse,
  GetImageFillsResponse,
} from "@figma/rest-api-spec";
import { downloadFigmaImage } from "~/utils/common.js";
import { Logger } from "~/server.js";
import axios from 'axios';
// @ts-ignore
import tunnel from 'tunnel';
import dotenv from 'dotenv';

// Đảm bảo biến môi trường được load
dotenv.config();

export interface FigmaError {
  status: number;
  err: string;
}

type FetchImageParams = {
  /**
   * The Node in Figma that will either be rendered or have its background image downloaded
   */
  nodeId: string;
  /**
   * The local file name to save the image
   */
  fileName: string;
  /**
   * The file mimetype for the image
   */
  fileType: "png" | "svg";
};

type FetchImageFillParams = Omit<FetchImageParams, "fileType"> & {
  /**
   * Required to grab the background image when an image is used as a fill
   */
  imageRef: string;
};

export class FigmaService {
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.figma.com/v1";
  private readonly proxyConfig: {
    host: string;
    port: number;
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    
    // Cấu hình proxy từ biến môi trường - không cần xác thực
    this.proxyConfig = {
      host: process.env.PROXY_HOST || 'fortigate.misa.local',
      port: parseInt(process.env.PROXY_PORT || '8080', 10)
    };
    
    console.log(`FigmaService initialized with proxy: ${this.proxyConfig.host}:${this.proxyConfig.port}`);
  }

  private async request<T>(endpoint: string): Promise<T> {
    if (typeof fetch !== "function") {
      throw new Error(
        "The MCP server is being run in a Node.js environment where `fetch` is not available. You won't be able to access any data related to the Figma file.\n\nAs the coding AI assistant, PLEASE ABORT THE CURRENT REQUEST. No alternate approaches will work. Help the user fix this issue so you can proceed by letting them know that they need to run the MCP server with Node.js version 18 or higher.",
      );
    }
    try {
      const url = `${this.baseUrl}${endpoint}`;
      
      Logger.log(`Calling ${url} through proxy ${this.proxyConfig.host}:${this.proxyConfig.port}`);
      
      // Tạo tunnel agent thay vì proxy agent
      const tunnelAgent = tunnel.httpsOverHttp({
        proxy: {
          host: this.proxyConfig.host,
          port: this.proxyConfig.port
        },
        rejectUnauthorized: false // Tùy chọn bỏ qua kiểm tra SSL nếu cần thiết
      });
      
      // Cấu hình axios dựa trên kết quả của test thành công
      const config = {
        method: 'get',
        url: url,
        headers: {
          'X-Figma-Token': this.apiKey,
          'User-Agent': 'curl/8.9.1',
          'Accept': '*/*'
        },
        httpsAgent: tunnelAgent,
        proxy: false as const // Tắt cấu hình proxy mặc định của axios
      };
      
      Logger.log(`Sending request with headers: ${JSON.stringify({...config.headers, 'X-Figma-Token': '***'})}`);
      const response = await axios(config);
      Logger.log(`Received response with status: ${response.status}`);
      return response.data;
    } catch (error) {
      Logger.log(`Error making request: ${error}`);
      if (axios.isAxiosError(error)) {
        if (error.response) {
          Logger.log(`Error status: ${error.response.status}`);
          Logger.log(`Error data: ${JSON.stringify(error.response.data || {})}`);
          throw {
            status: error.response.status,
            err: error.response.statusText || "Unknown error",
          } as FigmaError;
        }
        throw new Error(`Network error: ${error.message}`);
      }
      if (error instanceof Error) {
        throw new Error(`Failed to make request to Figma API: ${error.message}`);
      }
      throw new Error(`Failed to make request to Figma API: ${error}`);
    }
  }

  async getImageFills(
    fileKey: string,
    nodes: FetchImageFillParams[],
    localPath: string,
  ): Promise<string[]> {
    if (nodes.length === 0) return [];

    let promises: Promise<string>[] = [];
    const endpoint = `/files/${fileKey}/images`;
    const file = await this.request<GetImageFillsResponse>(endpoint);
    const { images = {} } = file.meta;
    promises = nodes.map(async ({ imageRef, fileName }) => {
      const imageUrl = images[imageRef];
      if (!imageUrl) {
        return "";
      }
      return downloadFigmaImage(fileName, localPath, imageUrl);
    });
    return Promise.all(promises);
  }

  async getImages(
    fileKey: string,
    nodes: FetchImageParams[],
    localPath: string,
  ): Promise<string[]> {
    const pngIds = nodes.filter(({ fileType }) => fileType === "png").map(({ nodeId }) => nodeId);
    const pngFiles =
      pngIds.length > 0
        ? this.request<GetImagesResponse>(
            `/images/${fileKey}?ids=${pngIds.join(",")}&scale=2&format=png`,
          ).then(({ images = {} }) => images)
        : ({} as GetImagesResponse["images"]);

    const svgIds = nodes.filter(({ fileType }) => fileType === "svg").map(({ nodeId }) => nodeId);
    const svgFiles =
      svgIds.length > 0
        ? this.request<GetImagesResponse>(
            `/images/${fileKey}?ids=${svgIds.join(",")}&scale=2&format=svg`,
          ).then(({ images = {} }) => images)
        : ({} as GetImagesResponse["images"]);

    const files = await Promise.all([pngFiles, svgFiles]).then(([f, l]) => ({ ...f, ...l }));

    const downloads = nodes
      .map(({ nodeId, fileName }) => {
        const imageUrl = files[nodeId];
        if (imageUrl) {
          return downloadFigmaImage(fileName, localPath, imageUrl);
        }
        return false;
      })
      .filter((url) => !!url);

    return Promise.all(downloads);
  }

  async getFile(fileKey: string, depth?: number): Promise<SimplifiedDesign> {
    try {
      const endpoint = `/files/${fileKey}${depth ? `?depth=${depth}` : ""}`;
      Logger.log(`Retrieving Figma file: ${fileKey} (depth: ${depth ?? "default"})`);
      const response = await this.request<GetFileResponse>(endpoint);
      Logger.log("Got response");
      const simplifiedResponse = parseFigmaResponse(response);
      writeLogs("figma-raw.json", response);
      writeLogs("figma-simplified.json", simplifiedResponse);
      return simplifiedResponse;
    } catch (e) {
      console.error("Failed to get file:", e);
      throw e;
    }
  }

  async getNode(fileKey: string, nodeId: string, depth?: number): Promise<SimplifiedDesign> {
    const endpoint = `/files/${fileKey}/nodes?ids=${nodeId}${depth ? `&depth=${depth}` : ""}`;
    const response = await this.request<GetFileNodesResponse>(endpoint);
    Logger.log("Got response from getNode, now parsing.");
    writeLogs("figma-raw.json", response);
    const simplifiedResponse = parseFigmaResponse(response);
    writeLogs("figma-simplified.json", simplifiedResponse);
    return simplifiedResponse;
  }

}

function writeLogs(name: string, value: any) {
  try {
    if (process.env.NODE_ENV !== "development") return;

    const logsDir = "logs";

    try {
      fs.accessSync(process.cwd(), fs.constants.W_OK);
    } catch (error) {
      Logger.log("Failed to write logs:", error);
      return;
    }

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir);
    }
    fs.writeFileSync(`${logsDir}/${name}`, JSON.stringify(value, null, 2));
  } catch (error) {
    console.debug("Failed to write logs:", error);
  }
}