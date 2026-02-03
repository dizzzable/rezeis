import apiClient from './client';
import type { ApiResponse } from '../types/entity.types';

export interface GetImportJobsParams {
  page?: number;
  limit?: number;
  status?: string;
  type?: string;
}

export interface ImportJob {
  id: string;
  entityType: string;
  filename: string;
  status: 'pending' | 'validating' | 'processing' | 'completed' | 'failed' | 'cancelled';
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  fileSize: number;
  errorLog?: string;
  createdAt: string;
  completedAt?: string;
}

export interface PaginatedImportJobs {
  data: ImportJob[];
  total: number;
  page: number;
  limit: number;
}

export interface ImportTemplate {
  id: string;
  name: string;
  description: string;
  entityType: 'users' | 'subscriptions' | 'plans';
  type: 'users' | 'subscriptions' | 'plans';
  columns: string[];
  sampleUrl?: string;
  isDefault: boolean;
}

export const importerService = {
  /**
   * Get list of import jobs with pagination
   */
  getJobs: async (params: GetImportJobsParams = {}): Promise<PaginatedImportJobs> => {
    const searchParams = new URLSearchParams();

    if (params.page) searchParams.set('page', params.page.toString());
    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.status) searchParams.set('status', params.status);
    if (params.type) searchParams.set('type', params.type);

    const response = await apiClient.get<ApiResponse<PaginatedImportJobs>>(
      `/importer/jobs?${searchParams.toString()}`
    );
    return response.data.data;
  },

  /**
   * Upload a file for import
   */
  uploadFile: async (file: File, type: 'users' | 'subscriptions' | 'plans'): Promise<{ jobId: string; message: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);

    const response = await apiClient.post<ApiResponse<{ jobId: string; message: string }>>('/importer/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data.data;
  },

  /**
   * Get import job details
   */
  getJobDetails: async (id: string): Promise<ImportJob> => {
    const response = await apiClient.get<ApiResponse<ImportJob>>(`/importer/jobs/${id}`);
    return response.data.data;
  },

  /**
   * Cancel an import job
   */
  cancelJob: async (id: string): Promise<{ success: boolean; message: string }> => {
    const response = await apiClient.post<ApiResponse<{ success: boolean; message: string }>>(`/importer/jobs/${id}/cancel`);
    return response.data.data;
  },

  /**
   * Delete an import job
   */
  deleteJob: async (id: string): Promise<void> => {
    await apiClient.delete(`/importer/jobs/${id}`);
  },

  /**
   * Download error log for a failed import
   */
  downloadErrors: async (id: string): Promise<Blob> => {
    const response = await apiClient.get<Blob>(`/importer/jobs/${id}/errors`, {
      responseType: 'blob',
    });
    return response.data;
  },

  /**
   * Get available import templates
   */
  getTemplates: async (): Promise<ImportTemplate[]> => {
    const response = await apiClient.get<ApiResponse<ImportTemplate[]>>('/importer/templates');
    return response.data.data;
  },

  /**
   * Download a template file
   */
  downloadTemplate: async (templateId: string): Promise<Blob> => {
    const response = await apiClient.get<Blob>(`/importer/templates/${templateId}/download`, {
      responseType: 'blob',
    });
    return response.data;
  },

  /**
   * Download sample template file (alias for downloadTemplate)
   */
  downloadSample: async (templateId: string): Promise<Blob> => {
    return importerService.downloadTemplate(templateId);
  },

  /**
   * Start an import job
   */
  startJob: async (jobId: string, options: { fieldMapping: Record<string, string>; validationRules: Record<string, unknown> }): Promise<{ success: boolean; message: string }> => {
    const response = await apiClient.post<ApiResponse<{ success: boolean; message: string }>>(`/importer/jobs/${jobId}/start`, options);
    return response.data.data;
  },
};
