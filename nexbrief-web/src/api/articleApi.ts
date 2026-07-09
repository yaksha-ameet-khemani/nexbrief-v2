import axios from "axios";
import type { Article, PageResponse } from "../types/Article";
import type { StatusResponse } from "../types/Status";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787/api";

const api = axios.create({
  baseURL: BASE_URL,
});

export interface FetchArticlesParams {
  source?: string;
  category?: string;
  keyword?: string;
  date?: string;
  page?: number;
  size?: number;
}

export const fetchArticles = async (
  params: FetchArticlesParams = {},
): Promise<PageResponse<Article>> => {
  const response = await api.get<PageResponse<Article>>("/articles", {
    params,
  });
  return response.data;
};

export const fetchStatus = async (): Promise<StatusResponse> => {
  const response = await api.get<StatusResponse>("/status");
  return response.data;
};
