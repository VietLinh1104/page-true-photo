// File: components/MultipartFileUploader.tsx
import React from "react";
import Uppy, { type UploadResult, UppyFile } from "@uppy/core";
import { Dashboard } from "@uppy/react";
import AwsS3Multipart, { AwsS3Part } from "@uppy/aws-s3-multipart";
import { create } from "@/lib/strapiClient";

// Import Uppy styles
import '@uppy/core/dist/style.min.css';
import '@uppy/dashboard/dist/style.min.css';

interface UploadApiRequest {
  file?: { name: string };
  contentType?: string;
  key?: string;
  uploadId?: string;
  partNumber?: number;
  parts?: AwsS3Part[];
}

interface ExtendedUppyFile extends UppyFile {
  uploadId?: string;
  response?: {
    body: {
      Key?: string;
      Bucket?: string;
      VersionId?: string;
      ETag?: string;
      ChecksumCRC32?: string;
    };
    status: number;
    uploadURL: string;
  };
  uploadURL?: string;
}

interface StorageBucketData {
  data: {
    fileName: string;
    key: string;
    bucket: string;
    uploadId: string | null;
    versionId: string | null;
    etag: string | null;
    checksumCRC32: string | null;
    url: string;
    size: number;
    mimeType: string;
    statusUpload: "completed" | "pending" | "failed";
  };
}

export interface ExtendedUploadResult extends UploadResult {
  documentId?: string;
}

const fetchUploadApiEndpoint = async (endpoint: string, data: UploadApiRequest) => {
  const res = await fetch(`/api/multipart-upload/${endpoint}`, {
    method: "POST",
    body: JSON.stringify(data),
    headers: {
      accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error: ${res.status} - ${err}`);
  }

  const response = await res.json();
  return response;
};

const createStorageBucket = async (data: StorageBucketData) => {
  try {
    const strapiData = {
        fileName: data.data.fileName,
        key: data.data.key,
        bucket: data.data.bucket,
        uploadId: data.data.uploadId,
        versionId: data.data.versionId,
        etag: data.data.etag,
        checksumCRC32: data.data.checksumCRC32,
        url: data.data.url,
        size: data.data.size,
        mimeType: data.data.mimeType,
        statusUpload: data.data.statusUpload
    };
    const response = await create('storage-buckets', strapiData);
    return response;
  } catch (error) {
    console.error('Error saving to Strapi:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
    throw error;
  }
};

export function MultipartFileUploader({
  onUploadSuccess,
  theme = "dark",
  triggerUploadRef,
  onUploadComplete,
}: {
  onUploadSuccess: (result: UploadResult) => void;
  theme?: "light" | "dark";
  triggerUploadRef: React.MutableRefObject<(() => Promise<string>) | null>;
  onUploadComplete?: () => void;
}) {
  const uppyRef = React.useRef<Uppy | null>(null);
  const documentIdRef = React.useRef<string | null>(null);
  const resolveUploadRef = React.useRef<((id: string) => void) | null>(null);

  if (!uppyRef.current) {
    uppyRef.current = new Uppy({
      autoProceed: false,
      restrictions: {
        maxNumberOfFiles: 1,
      },
    }).use(AwsS3Multipart, {
      createMultipartUpload: async (file) => {
        const contentType = file.type;
        return fetchUploadApiEndpoint("create-multipart-upload", {
          file: { name: file.name },
          contentType,
        });
      },
      listParts: (file, props) =>
        fetchUploadApiEndpoint("list-parts", {
          key: props.key,
          uploadId: props.uploadId,
        }),
      signPart: async (file, props) => {
        const response = await fetchUploadApiEndpoint("sign-part", {
          key: props.key,
          uploadId: props.uploadId,
          partNumber: props.partNumber,
        });
        return response;
      },
      completeMultipartUpload: (file, props) =>
        fetchUploadApiEndpoint("complete-multipart-upload", {
          key: props.key,
          uploadId: props.uploadId,
          parts: props.parts,
        }),
      abortMultipartUpload: (file, props) =>
        fetchUploadApiEndpoint("abort-multipart-upload", {
          key: props.key,
          uploadId: props.uploadId,
        }),
    });
  }

  const uppy = uppyRef.current;

  React.useEffect(() => {
    const onComplete = async (result: UploadResult) => {
      try {
        const uploadedFile = result.successful[0] as ExtendedUppyFile;
        if (!uploadedFile.response?.body?.Key || !uploadedFile.response.body.Bucket) {
          throw new Error('Missing required file data');
        }

        // Tạo URL công khai từ key
        const publicBaseURL = "https://document.truediting.com";
        const publicURL = `${publicBaseURL}/${uploadedFile.response.body.Key}`;

        const strapiData: StorageBucketData = {
          data: {
            fileName: uploadedFile.name,
            key: uploadedFile.response.body.Key,
            bucket: uploadedFile.response.body.Bucket,
            uploadId: uploadedFile.uploadId || null,
            versionId: uploadedFile.response.body.VersionId || null,
            etag: (uploadedFile.response.body.ETag || '').replace(/"/g, '') || null,
            checksumCRC32: uploadedFile.response.body.ChecksumCRC32 || null,
            url: publicURL, // Sử dụng URL công khai
            size: uploadedFile.size,
            mimeType: uploadedFile.type || 'application/octet-stream',
            statusUpload: "completed"
          }
        };

        const response = await createStorageBucket(strapiData);
        if (!response?.documentId) {
          console.error('Invalid response from createStorageBucket:', response);
          throw new Error('Missing documentId in response');
        }

        documentIdRef.current = response.documentId;
        onUploadSuccess({ ...result, documentId: response.documentId } as ExtendedUploadResult);

        if (resolveUploadRef.current) {
          resolveUploadRef.current(response.documentId);
        }
      } catch (error) {
        console.error('Error in upload completion:', error);
      } finally {
        onUploadComplete?.();
      }
    };

    uppy.on("complete", onComplete);

    return () => {
      uppy.off("complete", onComplete);
    };
  }, [onUploadSuccess, onUploadComplete, uppy]);

  React.useEffect(() => {
    const onFileAdded = () => {
      if (onUploadComplete) {
        onUploadComplete();
      }
    };

    uppy.on("file-added", onFileAdded);

    return () => {
      uppy.off("file-added", onFileAdded);
    };
  }, [onUploadComplete, uppy]);

  React.useEffect(() => {
    triggerUploadRef.current = async () => {
      documentIdRef.current = null;

      return new Promise<string>(async (resolve, reject) => {
        resolveUploadRef.current = resolve;

        try {
          await uppy.upload();

          // Chờ documentId được thiết lập
          const waitForDocumentId = () => {
            if (documentIdRef.current) {
              resolve(documentIdRef.current);
            } else {
              setTimeout(waitForDocumentId, 100);
            }
          };
          waitForDocumentId();
        } catch (error) {
          reject(error);
        }
      });
    };
  }, [triggerUploadRef, uppy]);

  return (
    <Dashboard
      uppy={uppy}
      showLinkToFileUploadResult={true}
      theme={theme}
      className="!border-none shadow-none"
      hideUploadButton={true}
    />
  );
}