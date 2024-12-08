Are you looking to deploy your Next.js project on AWS with high availability? This repository has everything you need:  

- **AWS CDK**: Automates infrastructure deployment, including:  
  - High-availability configuration for your Next.js deployment.  
  - An **S3 bucket** for file uploads.  
  - A **PostgreSQL** database.  
- **GitHub Actions**: Preconfigured for seamless CI/CD, enabling continuous integration and deployment.  

Simplify your deployment workflow and leverage the power of AWS and GitHub Actions to take your project to production effortlessly.  

## Architecture

![Cloud Architecture](architecture.drawio.png)

## Deployment Guide

Follow the steps below to deploy the application successfully:

### 1. Configure Dockerfile and .dockerignore

Copy `Dockerfile` and `.dockerignore` file inside the root directory of the Next.js project.

### 2. Copy CDK

Copy the `cdk/` directory to the root of your Next.js project.

### 3. Set Environment Variables

Create a `.env` file inside the `cdk/` directory and define the following environment variables:

```bash
CERTIFICATE_ARN=""
DATABASE_NAME=""
REPOSITORY_NAME=""
STATIC_BUCKET_NAME=""
UPLOAD_BUCKET_NAME=""
DOMAIN_NAME=""
ECS_CLUSTER_NAME=""
AURORA_READER_REPLICA=false
GITHUB_ACTIONS_USER_NAME="github-actions-deployment-user"
GITHUB_ACTIONS_ROLE_NAME="github-actions-deployment-role"
```

### 4. Deploy Artifact Stack

Deploy the artifact stack to set up the necessary infrastructure.

```bash
cdk deploy ArtifactStack
```

### 5. Configure Initial GitHub Secrets

Use the output values from the artifact stack to configure the initial GitHub secrets:

```bash
AWS_ROLE_TO_ASSUME=""
AWS_ACCESS_KEY_ID=""
AWS_SECRET_ACCESS_KEY="
AWS_REGION="
ECR_REPOSITORY=""
S3_BUCKET_NAME=""
```

### 6. Configure GitHub Actions

Create `build-deploy.yml` inside the `.github/workflows/` directory and define the following workflow:

```yml
name: Build and Push to AWS

on:
    push:
        branches: [main]

jobs:
    build-and-push:
        runs-on: ubuntu-latest
        steps:
            - name: Checkout repo
              uses: actions/checkout@v3

            - name: Configure AWS credentials
              uses: aws-actions/configure-aws-credentials@v4
              with:
                  aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
                  aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
                  role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}
                  aws-region: ${{ secrets.AWS_REGION }}
                  role-skip-session-tagging: true

            - name: Login to Amazon ECR
              id: login-ecr
              uses: aws-actions/amazon-ecr-login@v2

            - name: Build, tag, and push Docker image
              env:
                  ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
                  ECR_REPOSITORY: ${{ secrets.ECR_REPOSITORY }}
                  IMAGE_TAG: ${{ github.sha }}
              run: |
                  docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG -t $ECR_REGISTRY/$ECR_REPOSITORY:latest .
                  docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
                  docker push $ECR_REGISTRY/$ECR_REPOSITORY:latest

            - name: Upload to S3
              env:
                  BUCKET_NAME: ${{ secrets.S3_BUCKET_NAME }}
              run: |
                  aws s3 sync public/ s3://$BUCKET_NAME/ --delete

    deploy:
        needs: build-and-push
        runs-on: ubuntu-latest
        steps:
            - name: Configure AWS credentials
              uses: aws-actions/configure-aws-credentials@v4
              with:
                  aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
                  aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
                  role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}
                  aws-region: ${{ secrets.AWS_REGION }}
                  role-skip-session-tagging: true

            - name: Deploy to ECS
              env:
                  ECS_CLUSTER: ${{ secrets.ECS_CLUSTER }}
                  ECS_SERVICE: ${{ secrets.ECS_SERVICE }}
                  ECR_REPOSITORY: ${{ secrets.ECR_REPOSITORY }}
                  IMAGE_TAG: ${{ github.sha }}
              run: |
                  aws ecs update-service \
                    --cluster $ECS_CLUSTER \
                    --service $ECS_SERVICE \
                    --force-new-deployment

            - name: Purge CloudFront Cache
              env:
                  DISTRIBUTION_ID: ${{ secrets.CLOUDFRONT_DISTRIBUTION_ID }}
              run: |
                  aws cloudfront create-invalidation \
                    --distribution-id $DISTRIBUTION_ID \
                    --paths "/*"
```

Commit the changes and push to the main branch to trigger the GitHub Actions workflow.

**Note:** Deploy job is going to FAIL as the ECS service is not yet created. This is expected.

### 7. Deploy AppStack

Proceed to deploy the application stack after the artifact stack is in place.

> Inside the `app-stack.ts` file, you can update the `environment` property of the `TaskDefinition` construct to include the necessary environment variables for the application. Also, it is recommended to create secret environment variables using the AWS Secrets Manager and pass them to the task definition.

```bash
cdk deploy AppStack
```

### 8. Complete GitHub Actions Secrets

Use the output values from the application stack to complete the GitHub secrets:

```bash
ECS_CLUSTER=""
ECS_SERVICE=""
CLOUDFRONT_DISTRIBUTION_ID=""
```

### 9. Finalize Deployment

Once everything is configured correctly, your deployment should be ready to go.
