import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  Trash2,
  Download,
  Play,
  Settings,
  History,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { importerService, type ImportJob } from '@/api/importer.service';
import { MainLayout } from '@/components/layout';

const entityTypes = [
  { value: 'users', label: 'Users' },
  { value: 'subscriptions', label: 'Subscriptions' },
  { value: 'plans', label: 'Plans' },
];

export default function Importer() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('upload');
  const [entityType, setEntityType] = useState('users');
  const [previewJob, setPreviewJob] = useState<ImportJob | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  // Fetch jobs
  const { data: jobsData, isLoading: jobsLoading } = useQuery({
    queryKey: ['import-jobs'],
    queryFn: () => importerService.getJobs({ limit: 50 }),
  });

  // Fetch templates
  const { data: templates } = useQuery({
    queryKey: ['import-templates'],
    queryFn: () => importerService.getTemplates(),
  });

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      return importerService.uploadFile(file, entityType as 'users' | 'subscriptions' | 'plans');
    },
    onSuccess: (data) => {
      setPreviewJob({
        id: data.jobId,
        entityType: entityType,
        filename: '',
        status: 'pending',
        totalRows: 0,
        processedRows: 0,
        successRows: 0,
        failedRows: 0,
        fileSize: 0,
        createdAt: new Date().toISOString(),
      });
      setIsPreviewOpen(true);
      queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    },
    onError: () => {
      alert('Failed to upload file');
    },
  });

  // Start import mutation
  const startImportMutation = useMutation({
    mutationFn: (jobId: string) =>
      importerService.startJob(jobId, {
        fieldMapping: {},
        validationRules: {},
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
      setIsPreviewOpen(false);
      setActiveTab('history');
    },
    onError: () => {
      alert('Failed to start import');
    },
  });

  // Delete job mutation
  const deleteJobMutation = useMutation({
    mutationFn: (id: string) => importerService.deleteJob(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    },
  });

  // Dropzone
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (file) {
        uploadMutation.mutate(file);
      }
    },
    [entityType]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
    },
    maxFiles: 1,
    maxSize: 10 * 1024 * 1024, // 10MB
  });

  const downloadTemplate = (templateId: string) => {
    importerService.downloadSample(templateId).then((blob: Blob) => {
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'template.xlsx';
      a.click();
    });
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Data Importer</h1>
          <p className="text-muted-foreground">
            Import users, subscriptions, and plans from CSV or Excel files
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="upload" className="gap-2">
              <Upload className="h-4 w-4" />
              Upload
            </TabsTrigger>
            <TabsTrigger value="templates" className="gap-2">
              <Settings className="h-4 w-4" />
              Templates
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-2">
              <History className="h-4 w-4" />
              History
            </TabsTrigger>
          </TabsList>

          {/* Upload Tab */}
          <TabsContent value="upload" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Upload File</CardTitle>
                <CardDescription>
                  Select the type of data you want to import and upload your file
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Entity Type</label>
                  <Select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
                    <SelectTrigger className="w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {entityTypes.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div
                  {...getRootProps()}
                  className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
                    isDragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
                  }`}
                >
                  <input {...getInputProps()} />
                  <FileSpreadsheet className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                  {isDragActive ? (
                    <p className="text-lg font-medium">Drop the file here...</p>
                  ) : (
                    <>
                      <p className="text-lg font-medium">
                        Drag & drop a file here, or click to select
                      </p>
                      <p className="text-sm text-muted-foreground mt-2">
                        Supports CSV, XLSX, XLS (max 10MB)
                      </p>
                    </>
                  )}
                </div>

                {uploadMutation.isPending && (
                  <div className="space-y-2">
                    <Progress value={0} />
                    <p className="text-sm text-muted-foreground text-center">Uploading...</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Quick Templates */}
            <Card>
              <CardHeader>
                <CardTitle>Download Templates</CardTitle>
                <CardDescription>
                  Use these templates to ensure your data is formatted correctly
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {templates?.map((template) => (
                    <Button
                      key={template.id}
                      variant="outline"
                      size="sm"
                      onClick={() => downloadTemplate(template.id)}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      {template.name}
                    </Button>
                  ))}
                  <Button variant="outline" size="sm">
                    <Download className="h-4 w-4 mr-2" />
                    Users Template
                  </Button>
                  <Button variant="outline" size="sm">
                    <Download className="h-4 w-4 mr-2" />
                    Subscriptions Template
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Templates Tab */}
          <TabsContent value="templates">
            <Card>
              <CardHeader>
                <CardTitle>Import Templates</CardTitle>
                <CardDescription>
                  Manage your import templates and field mappings
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Entity Type</TableHead>
                      <TableHead>Default</TableHead>
                      <TableHead className="w-[100px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {templates?.map((template) => (
                      <TableRow key={template.id}>
                        <TableCell className="font-medium">{template.name}</TableCell>
                        <TableCell className="capitalize">{template.entityType}</TableCell>
                        <TableCell>
                          {template.isDefault && (
                            <Badge variant="default">Default</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => downloadTemplate(template.id)}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* History Tab */}
          <TabsContent value="history">
            <Card>
              <CardHeader>
                <CardTitle>Import History</CardTitle>
                <CardDescription>View and manage your import jobs</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Filename</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Progress</TableHead>
                      <TableHead>Results</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="w-[100px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobsLoading ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center">
                          Loading...
                        </TableCell>
                      </TableRow>
                    ) : jobsData?.data.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground">
                          No import jobs found
                        </TableCell>
                      </TableRow>
                    ) : (
                      jobsData?.data.map((job) => (
                        <TableRow key={job.id}>
                          <TableCell className="font-medium">{job.filename}</TableCell>
                          <TableCell className="capitalize">{job.entityType}</TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                job.status === 'completed'
                                  ? 'default'
                                  : job.status === 'failed'
                                  ? 'destructive'
                                  : 'secondary'
                              }
                            >
                              {job.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {job.totalRows > 0 && (
                              <div className="flex items-center gap-2">
                                <Progress
                                  value={(job.processedRows / job.totalRows) * 100}
                                  className="w-20"
                                />
                                <span className="text-xs text-muted-foreground">
                                  {job.processedRows}/{job.totalRows}
                                </span>
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {job.status === 'completed' && (
                              <div className="flex items-center gap-2 text-sm">
                                <CheckCircle className="h-4 w-4 text-green-500" />
                                {job.successRows}
                                {job.failedRows > 0 && (
                                  <>
                                    <AlertCircle className="h-4 w-4 text-red-500 ml-2" />
                                    {job.failedRows}
                                  </>
                                )}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {new Date(job.createdAt).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              {job.status === 'pending' && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => startImportMutation.mutate(job.id)}
                                >
                                  <Play className="h-4 w-4" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => deleteJobMutation.mutate(job.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Preview Dialog */}
        <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle>Import Preview</DialogTitle>
              <DialogDescription>
                Review the data before starting the import
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Total Rows</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-2xl font-bold">{previewJob?.totalRows || 0}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">File Size</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-2xl font-bold">
                      {previewJob ? (previewJob.fileSize / 1024).toFixed(1) : 0} KB
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Entity Type</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-2xl font-bold capitalize">
                      {previewJob?.entityType}
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsPreviewOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => previewJob && startImportMutation.mutate(previewJob.id)}
                disabled={startImportMutation.isPending}
              >
                {startImportMutation.isPending ? 'Starting...' : 'Start Import'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </MainLayout>
  );
}
