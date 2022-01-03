import * as core from '@actions/core'
import * as github from '@actions/github'
import * as xlsx from 'xlsx'
import {Octokit} from '@octokit/rest' //import to call rest api
import Pivot from 'quick-pivot'
import {graphql} from '@octokit/graphql' //import to call graphql api

async function run(): Promise<void> {
  try {
    //fetch data using octokit api
    const octokit = new Octokit({
      auth: core.getInput('token') //get the token from the action inputs.
    })
    const context = github.context //find the repo and owner from the github context
    let login: string = context.payload?.repository?.owner.login!
    let repoName: string = context.payload?.repository?.name!

    if (!login || !repoName) {
      //code to enable running on a local machine without a github context
      //set the INPUT_TOKEN and GITHUB_REPOSITORY (to login/reponame) env variables
      core.error('No login found, using GITHUB_REPOSITORY')
      const repo = process.env.GITHUB_REPOSITORY!
      login = repo.split('/')[0]
      repoName = repo.split('/')[1]
    }

    //get the code scanning report for repo.
    const csIssues: string[][] = await getCodeScanningReport(
      login,
      repoName,
      octokit
    )

    //get the dependency graph report for repo.
    const dgInfo: string[][] = await getDependencyGraphReport(login, repoName)

    // const Pivot = require('quick-pivot')

    const dgPivotData: string[][] = generatePivot(
      ['manifest'],
      ['licenseInfo'],
      'packageName',
      'count',
      dgInfo
    )

    const csPivotData: string[][] = generatePivot(
      ['rule'],
      ['severity'],
      'html_url',
      'count',
      csIssues
    )

    //console.log(pivotData)

    //create an excel file with the dataset
    const wb = xlsx.utils.book_new()
    const ws = xlsx.utils.aoa_to_sheet(csIssues)
    const ws1 = xlsx.utils.aoa_to_sheet(dgInfo)
    const ws2 = xlsx.utils.aoa_to_sheet(dgPivotData)
    const ws3 = xlsx.utils.aoa_to_sheet(csPivotData)
    xlsx.utils.book_append_sheet(wb, ws, 'code-scanning-issues')
    xlsx.utils.book_append_sheet(wb, ws1, 'dependencies-list')
    xlsx.utils.book_append_sheet(wb, ws2, 'dependencies-Pivot')
    xlsx.utils.book_append_sheet(wb, ws3, 'code-scanning-Pivot')
    xlsx.writeFile(wb, 'alerts.xlsx')
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()

function generatePivot(
  rowHeader: string[],
  colHeader: string[],
  aggregationHeader: string,
  aggregator: string,
  dgInfo: string[][]
): string[][] {
  //const columnsToPivot = [`${colHeader}`]
  //const rowsToPivot = [`${rowHeader}`]
  const aggregationDimensions = [`${aggregationHeader}`]
  //const aggregator = 'count'
  const pivot = new Pivot(
    dgInfo,
    rowHeader,
    colHeader,
    aggregationDimensions,
    aggregator
  )
  //console.log(pivot.data.table)
  const pivotData: string[][] = []
  for (const row of pivot.data.table) {
    const pivotRow: string[] = []
    for (const col of row.value) {
      pivotRow.push(col)
      //console.log(col)
    }
    pivotData.push(pivotRow)
  }
  return pivotData
}

async function getCodeScanningReport(
  login: string,
  repoName: string,
  octokit: Octokit
): Promise<string[][]> {
  //the paginatte API will fecth all records (100 at a time).
  const data = await octokit.paginate(
    octokit.rest.codeScanning.listAlertsForRepo,
    {
      owner: login,
      repo: repoName
    }
  )

  // create a array of objects with the data
  const csvData: string[][] = []
  const header: string[] = [
    'toolName',
    'toolVersion',
    'alertNumber',
    'htmlUrl',
    'state',
    'rule',
    'severity',
    'location',
    'start-line',
    'end-line',
    'createdAt',
    'updatedAt',
    'fixedAt',
    'dismissedAt',
    'dismissedBy'
  ]

  csvData.push(header)
  //iterate over the data and print the alert information
  for (const alert of data) {
    //create an array of string values
    const rule: any = alert.rule
    let securitySeverity = ''
    if (rule.security_severity_level) {
      securitySeverity = rule.security_severity_level
    } else {
      securitySeverity = rule.severity
    }
    const _alert: any = alert
    const row: string[] = [
      alert.tool.name!,
      alert.tool.version!,
      alert.number.toString(),
      alert.html_url,
      alert.state,
      rule.id,
      securitySeverity,
      alert.most_recent_instance.location!.path,
      alert.most_recent_instance.location!.start_line,
      alert.most_recent_instance.location!.end_line,
      alert.created_at,
      _alert.updated_at,
      _alert.fixed_at,
      alert.dismissed_at,
      alert.dismissed_by
    ]

    csvData.push(row)
  }

  return csvData
}
async function getDependencyGraphReport(
  login: string,
  repoName: string
): Promise<string[][]> {
  //get the dependency graph for the repo and parse the data
  const {repository} = await graphql(
    `
      {
        repository(owner: "${login}", name: "${repoName}") {
          name
          licenseInfo {
            name
          }
          dependencyGraphManifests {
            totalCount
            edges {
              node {
                filename
                dependencies {
                  edges {
                    node {
                      packageName
                      packageManager
                      requirements
                      repository {
                        licenseInfo {
                          name
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    {
      headers: {
        authorization: `token ${core.getInput('token')}`,
        accept: 'application/vnd.github.hawkgirl-preview+json'
      }
    }
  )

  const csvData: string[][] = []
  const header: string[] = [
    'manifest',
    'packageName',
    'packageManager',
    'requirements',
    'licenseInfo'
  ]

  csvData.push(header)
  for (const dependency of repository.dependencyGraphManifests.edges) {
    for (const dependencyEdge of dependency.node.dependencies.edges) {
      let licenseInfo = ''
      if (
        //null checks in case a dependency has no license info
        dependencyEdge.node &&
        dependencyEdge.node.repository &&
        dependencyEdge.node.repository.licenseInfo
      ) {
        licenseInfo = dependencyEdge.node.repository.licenseInfo.name
      }
      const row: string[] = [
        dependency.node.filename,
        dependencyEdge.node.packageName,
        dependencyEdge.node.packageManager,
        dependencyEdge.node.requirements,
        licenseInfo
      ]

      csvData.push(row)
    }
  }
  return csvData
}
