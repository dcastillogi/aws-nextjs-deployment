import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as elasticloadbalancingv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager";
import * as rds from "aws-cdk-lib/aws-rds";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as logs from "aws-cdk-lib/aws-logs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";

interface AppStackProps extends cdk.StackProps {
    readonly config: {
        readonly environmentVariables: { [key: string]: string };
        readonly secrets: string[];
    };
}

export class AppStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: AppStackProps) {
        super(scope, id, props);

        const domainCert = certificatemanager.Certificate.fromCertificateArn(
            this,
            "DomainCertificate",
            process.env.CERTIFICATE_ARN!
        );

        const vpc = new ec2.Vpc(this, "AppVPC", {
            maxAzs: 2,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: "public",
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: "private",
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });

        // Use the existing ECR repository
        const repository = ecr.Repository.fromRepositoryName(
            this,
            "AppRepository",
            process.env.REPOSITORY_NAME!
        );

        // Use S3 bucket for static assets
        const staticBucket = s3.Bucket.fromBucketName(
            this,
            "AppStaticBucket",
            process.env.STATIC_BUCKET_NAME!
        );

        // S3 Bucket for Uploads
        const uploadBucket = new s3.Bucket(this, "AppUploadBucket", {
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            autoDeleteObjects: false,
            bucketName: process.env.UPLOAD_BUCKET_NAME!,
        });

        // Secret Manager App Secrets
        const secret = secretsmanager.Secret.fromSecretNameV2(
            this,
            "AppSecret",
            process.env.SECRET_NAME!
        );

        // Aurora Serverless Cluster
        const auroraCluster = new rds.DatabaseCluster(
            this,
            "AuroraServerlessCluster",
            {
                engine: rds.DatabaseClusterEngine.auroraPostgres({
                    version: rds.AuroraPostgresEngineVersion.VER_16_4,
                }),
                serverlessV2MinCapacity: 0.5,
                serverlessV2MaxCapacity: 1,
                vpc: vpc,
                vpcSubnets: {
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
                writer: rds.ClusterInstance.serverlessV2("main"),
                readers: [
                    ...(process.env.AURORA_READER_REPLICA !== 'false' 
                        ? [
                            rds.ClusterInstance.serverlessV2("replica", {
                                scaleWithWriter: true,
                            }),
                        ] 
                        : []),
                ],
                removalPolicy: cdk.RemovalPolicy.RETAIN,
                storageEncrypted: true,
                backup: {
                    retention: Duration.days(15),
                    preferredWindow: "06:00-07:00",
                },
                credentials: rds.Credentials.fromSecret(secret),
            }
        );

        // ECS Cluster
        const cluster = new ecs.Cluster(this, "AppCluster", {
            vpc: vpc,
            clusterName: process.env.ECS_CLUSTER_NAME!,
        });

        // Create task role for S3UploadBucket
        const taskRole = new iam.Role(this, "TaskRole", {
            assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        });

        uploadBucket.grantReadWrite(taskRole);

        // Fargate Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(
            this,
            "AppTaskDefinition",
            {
                memoryLimitMiB: 512,
                cpu: 256,
                taskRole: taskRole,
            }
        );

        /* ====  GET ENVIROMENT VARIABLES ==== */

        // Get environment variables

        // Create environment variables
        const envVars: { [key: string]: string } = {
            ...props?.config?.environmentVariables,
            PORT: "3000",
        };

        // Get environment variable keys
        const envKeys = Object.keys(envVars);

        // Get secret keys from configuration
        const secrets = props?.config?.secrets || [];

        // Add container to task definition
        taskDefinition.addContainer("AppContainer", {
            image: ecs.ContainerImage.fromEcrRepository(repository),
            portMappings: [
                {
                    containerPort: 3000,
                    protocol: ecs.Protocol.TCP,
                    appProtocol: ecs.AppProtocol.http,
                    name: "http",
                },
            ],
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: "app-container",
                logRetention: logs.RetentionDays.ONE_WEEK,
            }),
            environment: envKeys.reduce(
                (acc, key) => ({
                    ...acc,
                    [key]: envVars[key],
                }),
                {}
            ),
            secrets: secrets.reduce((acc, key) => {
                return {
                    ...acc,
                    [key]: ecs.Secret.fromSecretsManager(secret, key),
                };
            }, {} as { [key: string]: ecs.Secret }),
            healthCheck: {
                command: [
                    "CMD-SHELL",
                    "sh -c 'curl -f http://$(hostname -i):3000/api/healthCheck || exit 1'",
                ],
                interval: Duration.seconds(30),
                timeout: Duration.seconds(5),
                retries: 3,
                startPeriod: Duration.seconds(120),
            },
        });

        // Security Group for ALB
        const albSecurityGroup = new ec2.SecurityGroup(
            this,
            "AppALBSecurityGroup",
            {
                vpc,
                allowAllOutbound: true,
                description: "Security group for application load balancer",
            }
        );

        // Allow ALB to receive traffic from cloudfront
        albSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),
            "Allow HTTPS traffic"
        );

        // Allow ALB to receive traffic from the Fargate service
        albSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(3000),
            "Allow HTTP traffic"
        );

        // Application Load Balancer
        const alb = new elasticloadbalancingv2.ApplicationLoadBalancer(
            this,
            "AppLoadBalancer",
            {
                vpc,
                internetFacing: true,
                vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
                securityGroup: albSecurityGroup,
            }
        );

        // ALB Listener
        const listener = alb.addListener("https", {
            port: 443,
            protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
            certificates: [domainCert],
        });

        const serviceSecurityGroup = new ec2.SecurityGroup(
            this,
            "ServiceSecurityGroup",
            {
                vpc,
                allowAllOutbound: true,
                description: "Security group for Fargate service",
            }
        );

        // Allow to ALB from servicex
        serviceSecurityGroup.addIngressRule(
            albSecurityGroup,
            ec2.Port.tcp(3000),
            "Allow inbound from ALB"
        );

        const dbSecurityGroup = auroraCluster.connections.securityGroups[0];

        dbSecurityGroup.addIngressRule(
            serviceSecurityGroup,
            ec2.Port.tcp(5432),
            "Allow Aurora access from ECS tasks"
        );

        // Fargate Service
        const fargateService = new ecs.FargateService(
            this,
            "AppFargateService",
            {
                cluster,
                taskDefinition,
                desiredCount: 2,
                assignPublicIp: false,
                circuitBreaker: { rollback: true },
                securityGroups: [serviceSecurityGroup],
                vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
                healthCheckGracePeriod: Duration.seconds(120),
            }
        );

        // Add target group to listener
        listener.addTargets("ApplicationFleet", {
            targets: [fargateService],
            port: 3000,
            protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
            healthCheck: {
                path: "/api/healthCheck",
                unhealthyThresholdCount: 2,
                healthyThresholdCount: 2,
                interval: Duration.seconds(60),
                timeout: Duration.seconds(5),
                healthyHttpCodes: "200-299",
            },
        });

        const albCachePolicy = new cloudfront.CachePolicy(
            this,
            "CustomCachePolicy",
            {
                cachePolicyName: "CustomALBCachePolicy",
                comment: "Cache policy for ALB origin with Host header",
                defaultTtl: Duration.days(0),
                minTtl: Duration.seconds(0),
                maxTtl: Duration.days(0),
                headerBehavior:
                    cloudfront.CacheHeaderBehavior.allowList("Host"),
                enableAcceptEncodingGzip: true,
                enableAcceptEncodingBrotli: true,
            }
        ); // To send the Host header to the origin for SSL certificate validation

        // WAFv2 WebACL
        const WebAcl = new wafv2.CfnWebACL(this, "AppWebACL", {
            scope: "CLOUDFRONT",
            defaultAction: {
                allow: {},
            },
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: "AppWebACL",
                sampledRequestsEnabled: true,
            },
            rules: [
                {
                    name: "AllowAll",
                    priority: 0,
                    statement: {
                        managedRuleGroupStatement: {
                            vendorName: "AWS",
                            name: "AWSManagedRulesCommonRuleSet",
                        },
                    },
                    overrideAction: {
                        none: {},
                    },
                    visibilityConfig: {
                        sampledRequestsEnabled: true,
                        cloudWatchMetricsEnabled: true,
                        metricName: "AllowAll",
                    },
                },
                {
                    name: "IPRateLimitingRule",
                    priority: 1,
                    statement: {
                        rateBasedStatement: {
                            limit: 600,
                            aggregateKeyType: "IP",
                        },
                    },
                    action: {
                        block: {},
                    },
                    visibilityConfig: {
                        sampledRequestsEnabled: true,
                        cloudWatchMetricsEnabled: true,
                        metricName: "IPRateLimitingRule",
                    },
                },
            ],
        });

        // CloudFront Distribution
        const distribution = new cloudfront.Distribution(
            this,
            "AppDistribution",
            {
                defaultBehavior: {
                    origin: new origins.LoadBalancerV2Origin(alb, {
                        protocolPolicy:
                            cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
                    }),
                    viewerProtocolPolicy:
                        cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: albCachePolicy,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    originRequestPolicy:
                        cloudfront.OriginRequestPolicy.ALL_VIEWER,
                },
                additionalBehaviors: {
                    "/static/*": {
                        origin: origins.S3BucketOrigin.withOriginAccessControl(
                            staticBucket
                        ),
                        viewerProtocolPolicy:
                            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                        allowedMethods:
                            cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    },
                },
                certificate: domainCert,
                domainNames: [
                    process.env.DOMAIN_NAME!,
                    "www." + process.env.DOMAIN_NAME!,
                ],
                webAclId: WebAcl.attrArn,
            }
        );

        // Update policy for GitHub Actions role to deploy
        const githubActionsRole = iam.Role.fromRoleArn(
            this,
            "GitHubActionsRole",
            `arn:aws:iam::${this.account}:role/${process.env
                .GITHUB_ACTIONS_ROLE_NAME!}`
        );

        githubActionsRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
                actions: ["cloudfront:CreateInvalidation"],
                resources: [
                    `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
                ],
            })
        );

        githubActionsRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
                actions: ["ecs:UpdateService"],
                resources: [fargateService.serviceArn],
            })
        );

        githubActionsRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
                actions: [
                    "ecs:DescribeTaskDefinition",
                    "ecs:RegisterTaskDefinition",
                ],
                resources: ["*"],
            })
        );

        githubActionsRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
                actions: ["iam:PassRole"],
                resources: ["*"],
            })
        );

        // Outputs
        new cdk.CfnOutput(this, "CloudFrontDistribution", {
            value: distribution.distributionId,
        });

        new cdk.CfnOutput(this, "ECSCluster", {
            value: cluster.clusterName,
        });

        new cdk.CfnOutput(this, "ECSService", {
            value: fargateService.serviceName,
        });

        new cdk.CfnOutput(this, "CloudFrontURL", {
            value: `https://${distribution.domainName}`,
        });
    }
}
