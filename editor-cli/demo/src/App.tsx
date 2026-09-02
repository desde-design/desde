import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const METRICS = [
  { label: "Active workspaces", value: "1,284", delta: "+12.4%", positive: true },
  { label: "Requests today", value: "48,210", delta: "+3.1%", positive: true },
  { label: "Error rate", value: "0.42%", delta: "+0.18%", positive: false },
  { label: "Median latency", value: "184ms", delta: "-22ms", positive: true },
]

const ROWS = [
  { name: "acme-production", region: "us-east-1", status: "Healthy", requests: "18,402" },
  { name: "acme-staging", region: "us-east-1", status: "Healthy", requests: "4,118" },
  { name: "northwind-eu", region: "eu-west-2", status: "Degraded", requests: "9,733" },
  { name: "internal-tools", region: "us-west-2", status: "Healthy", requests: "2,004" },
]

export function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <span className="font-semibold">Northwind Analytics</span>
        <Button size="sm">Invite a teammate</Button>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
        <section className="space-y-2">
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="text-muted-foreground">
            This is a demo prototype. Click anything on this page to select it, then edit it in
            the panel on the right.
          </p>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {METRICS.map((metric) => (
            <Card key={metric.label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-normal text-muted-foreground">
                  {metric.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-2xl font-semibold">{metric.value}</p>
                <Badge variant={metric.positive ? "secondary" : "destructive"}>
                  {metric.delta}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Workspaces</h2>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ROWS.map((row) => (
                  <TableRow key={row.name}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-muted-foreground">{row.region}</TableCell>
                    <TableCell>
                      <Badge variant={row.status === "Healthy" ? "secondary" : "outline"}>
                        {row.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{row.requests}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Settings</h2>
          <Card>
            <CardContent className="flex items-center justify-between py-4">
              <div className="space-y-1">
                <p className="font-medium">Send a weekly digest</p>
                <p className="text-muted-foreground">
                  Every workspace owner receives one summary each Monday.
                </p>
              </div>
              <Switch defaultChecked />
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  )
}
