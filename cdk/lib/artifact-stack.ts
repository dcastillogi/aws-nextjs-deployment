import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export class ArtifactStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // ECR Repository
        const repository = new ecr.Repository(this, "AppRepository", {
            repositoryName: process.env.REPOSITORY_NAME!,
            imageScanOnPush: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // S3 Bucket for Static Assets
        const staticBucket = new s3.Bucket(this, "AppStaticBucket", {
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            bucketName: process.env.STATIC_BUCKET_NAME!,
        });

        // Add bucket policy for CloudFront access
        staticBucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:GetObject"],
                principals: [
                    new iam.ServicePrincipal("cloudfront.amazonaws.com"),
                ],
                resources: [staticBucket.arnForObjects("*")],
                conditions: {
                    StringLike: {
                        "AWS:SourceArn": `arn:aws:cloudfront::${
                            cdk.Stack.of(this).account
                        }:distribution/*`,
                    },
                },
            })
        );

        // Create user for GitHub Actions
        const githubActionsUser = new iam.User(
            this,
            "GitHubActionsDeploymentUser",
            {
                userName: process.env.GITHUB_ACTIONS_USER_NAME!,
            }
        );

        // IAM Role for GitHub Actions
        const githubActionsRole = new iam.Role(
            this,
            "GithubActionsDeploymentRole",
            {
                assumedBy: githubActionsUser,
                description: "Role assumed by github user for deployment tasks",
                roleName: process.env.GITHUB_ACTIONS_ROLE_NAME!,
            }
        );
        // Attach policies to the IAM Role
        githubActionsRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    "ecr:InitiateLayerUpload",
                    "ecr:UploadLayerPart",
                    "ecr:CompleteLayerUpload",
                    "ecr:PutImage",
                    "ecr:BatchCheckLayerAvailability",
                ],
                resources: [repository.repositoryArn],
            })
        );
        githubActionsRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ["ecr:GetAuthorizationToken"],
                resources: ["*"],
            })
        );
        githubActionsRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
                resources: [staticBucket.arnForObjects("*")],
            })
        );

        githubActionsRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ["s3:ListBucket"],
                resources: [staticBucket.bucketArn],
            })
        );

        githubActionsUser.addToPolicy(
            new iam.PolicyStatement({
                actions: ["sts:AssumeRole"],
                resources: [githubActionsRole.roleArn],
            })
        );

        // Create access key for GitHub Actions user
        const accessKey = new iam.CfnAccessKey(
            this,
            "GitHubActionsUserAccessKeyId",
            {
                userName: githubActionsUser.userName,
            }
        );

        // Outputs
        new cdk.CfnOutput(this, "GitHubActionsUserAccessKey", {
            value: accessKey.ref,
        });

        new cdk.CfnOutput(this, "GitHubActionsUserSecretAccessKey", {
            value: accessKey.attrSecretAccessKey,
        });
    }
}
